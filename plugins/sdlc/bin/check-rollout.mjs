#!/usr/bin/env node
// The Rollout gate. Run after a ticket's PR is merged, on a machine whose
// kubectl can read the cluster. The canary's own analysis decides whether a
// release is promoted; this follows one merge to the cluster and records
// what happened: which images it produced, whether each Rollout settled on
// them, what the analysis measured, and whether the new pods have served a
// request without a server fault. Read-only: `kubectl get` and GETs to the
// public address. Exits 1 when the gate fails.
//
//   node bin/check-rollout.mjs --ticket ABC-12 --commit <merge commit>
//        [--services identity,web | none] [--wait 20] [--no-smoke] [--round 2] [--comment]
//
// --wait polls for that many minutes (20 unless given) until every image
// is committed and every Rollout settles or aborts. Exits 3, not 1, when
// the only thing wrong is that the rollout hasn't finished yet.
// Nothing is written to the repo: the branch is gone by now, so this
// record lives in its ticket comment.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emit, parseArgs, projectRoot, record, requireConfig } from './lib.mjs';

// The same codes the canary's AnalysisTemplate counts as the server's fault.
const FAULT_CODES = ['Unknown', 'Internal', 'Unavailable', 'DataLoss', 'DeadlineExceeded', 'Unimplemented'];
const MAX_FAULT_RATIO = 0.01;
const short = (digest) => digest.slice(0, 19);

// { identity: 'sha256:…' } from the file ArgoCD Image Updater writes.
export function digests(yaml) {
  const out = {};
  for (const m of yaml.matchAll(/name:\s*(\w+)\.image\.tag\s*\n\s*value:\s*\S*@(sha256:[0-9a-f]{64})/g)) out[m[1]] = m[2];
  return out;
}

// The images a merge rebuilds: CI builds one when a file under its inputs
// changed (the `image` job's matrix in ci.yaml; rollout.json mirrors it).
export function rebuilt(files, services) {
  return Object.keys(services).filter((s) => files.some((f) => (services[s].inputs ?? []).some((i) => (i.endsWith('/') ? f.startsWith(i) : f === i))));
}

// Image Updater writes each image in its own commit, minutes apart. Until
// a rebuilt image's digest differs from the one at the merge, it isn't out.
export const waiting = (expected, before, after) => expected.filter((s) => !after[s] || after[s] === before[s]);

// Old pods are still scaling down for a minute after the phase turns Healthy.
export function settled(rollout) {
  const s = rollout.status ?? {};
  return s.phase === 'Healthy' && s.stableRS === s.currentPodHash && s.replicas === s.updatedReplicas && s.readyReplicas === s.replicas;
}
export const aborted = (rollout) => rollout.status?.abort === true || rollout.status?.phase === 'Degraded';

const onDigest = (rollout, digest) => (rollout.spec?.template?.spec?.containers ?? []).some((c) => (c.image ?? '').includes(digest));

// Not finished is different from failed: only an abort is a verdict.
export const unfinished = (rollout, digest) => !aborted(rollout) && !(onDigest(rollout, digest) && settled(rollout));

export function rolloutCheck(name, rollout, digest) {
  const s = rollout.status ?? {};
  let problem = null;
  if (aborted(rollout)) problem = `Aborted (${s.phase}): ${s.message ?? 'no message'}; the stable version is still serving`;
  else if (!onDigest(rollout, digest)) problem = `The Rollout isn't on ${short(digest)} yet: ArgoCD hasn't synced it`;
  else if (s.phase !== 'Healthy') problem = `${s.phase ?? 'Unknown'} at step ${s.currentStepIndex ?? '?'}: ${s.message ?? 'no message'}`;
  else if (!settled(rollout)) problem = `Healthy, but old pods are still scaling down (${s.updatedReplicas} of ${s.replicas} updated)`;
  return { name: `rollout:${name}`, pass: !problem, detail: problem ?? `Healthy on ${s.currentPodHash} with ${short(digest)}, ${s.replicas} replicas` };
}

// One AnalysisRun per analysis step, all Successful. Returns the check and
// what each metric measured, for the record's evidence.
export function analysisCheck(name, rollout, runs) {
  const hash = rollout.status?.currentPodHash;
  const steps = (rollout.spec?.strategy?.canary?.steps ?? []).filter((s) => s.analysis).length;
  const mine = runs.filter((r) => r.metadata?.labels?.['rollouts-pod-template-hash'] === hash && (r.metadata?.ownerReferences ?? []).some((o) => o.kind === 'Rollout' && o.name === name));
  const bad = mine.filter((r) => r.status?.phase !== 'Successful');
  const evidence = mine.flatMap((r) => (r.status?.metricResults ?? []).map((m) => `${name} ${r.metadata.name} ${m.name}: ${m.phase}, measured ${(m.measurements ?? []).map((x) => x.value ?? x.phase).join(' ')}`));
  let problem = null;
  if (bad.length) problem = bad.map((r) => `${r.metadata.name} is ${r.status?.phase ?? 'not finished'}${r.status?.message ? `: ${r.status.message}` : ''}`).join('; ');
  else if (mine.length < steps) problem = `${mine.length} of ${steps} analysis runs exist for ${hash}`;
  return { check: { name: `analysis:${name}`, pass: !problem, detail: problem ?? (steps ? `${mine.length} runs Successful` : 'The Rollout has no analysis steps') }, evidence };
}

export function podsCheck(name, pods, hash, digest) {
  const mine = pods.filter((p) => p.metadata?.labels?.['rollouts-pod-template-hash'] === hash && p.metadata?.labels?.['app.kubernetes.io/name'] === name);
  const statuses = mine.flatMap((p) => p.status?.containerStatuses ?? []);
  const restarts = statuses.reduce((n, c) => n + (c.restartCount ?? 0), 0);
  let problem = null;
  if (mine.length === 0) problem = `No pods for ${hash}`;
  else if (statuses.some((c) => !c.ready)) problem = 'A container is not ready';
  else if (restarts > 0) problem = `${restarts} restarts since the rollout`;
  else if (!statuses.some((c) => (c.imageID ?? '').includes(digest))) problem = `No container runs ${short(digest)}`;
  return { name: `pods:${name}`, pass: !problem, detail: problem ?? `${mine.length} pods ready on ${short(digest)}, no restarts` };
}

// The canary's analysis passes when it sees no requests, so a Healthy
// Rollout alone doesn't show the new pods served anything.
const sum = (byCode) => Object.values(byCode).reduce((n, v) => n + v, 0);

// `sent` smoke requests went out after the counter read `before`; the
// counter adds up everything since the rollout, so only its rise shows
// that this run's requests arrived.
export function servedCheck(name, hash, byCode, { before = 0, sent = 0 } = {}) {
  const total = sum(byCode);
  const faults = Object.entries(byCode).filter(([code]) => FAULT_CODES.includes(code)).reduce((n, [, v]) => n + v, 0);
  let problem = null;
  if (!(total > 0)) problem = `The pods of ${hash} have counted no requests: nothing shows the new pods answered one`;
  else if (total - before < sent) problem = `The pods of ${hash} counted ${total - before} of the ${sent} smoke requests`;
  else if (faults / total > MAX_FAULT_RATIO) problem = `${faults} of ${total} requests to ${hash} were server faults`;
  const codes = Object.entries(byCode).map(([code, v]) => `${v} ${code}`).join(', ');
  return { name: `served:${name}`, pass: !problem, detail: problem ?? `${total} requests to ${hash} (${codes})${sent ? `, ${total - before} since the smoke requests` : ''}, ${faults} server faults` };
}

export function smokeCheck(name, path, statuses) {
  const bad = statuses.filter((s) => !(s >= 200 && s < 500));
  return { name: `smoke:${name}`, pass: statuses.length > 0 && bad.length === 0, detail: `GET ${path} x${statuses.length}: ${[...new Set(statuses)].map((s) => s || 'no answer').join(', ')}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 4).join(' ')}: ${(r.stderr || r.error?.message || '').trim().slice(0, 300)}`);
  return r.stdout;
};
const kget = (ns, ...what) => JSON.parse(run('kubectl', ['get', ...what, '-n', ns, '-o', 'json']));

// { Unauthenticated: 5 }. Pods are new, so their counters started at zero:
// the raw value is the requests since the rollout. increase() would miss a
// series' first sample.
function counted(config, hash) {
  const p = config.prometheus;
  const query = `sum(grpc_server_requests_total{namespace="${config.namespace}",rollouts_pod_template_hash="${hash}"}) by (code)`;
  const path = `/api/v1/namespaces/${p.namespace}/services/${p.service}:${p.port}/proxy/api/v1/query?query=${encodeURIComponent(query)}`;
  const result = JSON.parse(run('kubectl', ['get', '--raw', path])).data?.result ?? [];
  return Object.fromEntries(result.map((r) => [r.metric.code ?? 'unknown', Number(r.value[1])]));
}

async function smoke(url, times = 5) {
  const statuses = [];
  for (let i = 0; i < times; i++) {
    statuses.push(await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) }).then((r) => r.status, () => 0));
  }
  return statuses;
}

async function main(argv) {
  requireConfig();
  const { flags } = parseArgs(argv, ['--ticket', '--commit', '--services', '--wait', '--round']);
  if (!flags.ticket || !flags.commit) {
    console.error('usage: check-rollout.mjs --ticket ID --commit <merge commit> [--services a,b | none] [--wait minutes] [--no-smoke] [--round N] [--comment]');
    return 2;
  }
  const path = process.env.SDLC_ROLLOUT || join(projectRoot(), '.sdlc/rollout.json');
  if (!existsSync(path)) {
    console.error(`No ${path}: this project doesn't deploy with Argo Rollouts yet, so there is no rollout to judge (watch-rollout says what to do with the ticket).`);
    return 2;
  }
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const before = digests(run('git', ['show', `${flags.commit}:${config.source}`]));
  const files = run('git', ['diff', '--name-only', `${flags.commit}^`, flags.commit]).split('\n').filter(Boolean);
  const services = flags.services === 'none' ? [] : flags.services ? flags.services.split(',').map((s) => s.trim()).filter((s) => config.services[s]) : rebuilt(files, config.services);
  const deadline = Date.now() + Number(flags.wait ?? 20) * 60_000;

  const checks = [];
  const evidence = [];
  // Checks that fail only because the rollout hasn't finished.
  const notYet = new Set();
  let after = digests(run('git', ['show', `origin/main:${config.source}`]));
  while (waiting(services, before, after).length && Date.now() < deadline) {
    await sleep(30_000);
    spawnSync('git', ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    after = digests(run('git', ['show', `origin/main:${config.source}`]));
  }
  const late = waiting(services, before, after);
  if (late.length) notYet.add('images');
  checks.push({
    name: 'images', pass: late.length === 0,
    detail: late.length ? `No new digest on main yet for: ${late.join(', ')} (CI builds each image, then Image Updater commits it)`
      : services.length ? services.map((s) => `${s} ${short(after[s])}`).join(', ') : 'This merge rebuilds no image: nothing to roll out',
  });

  const known = services.filter((s) => !late.includes(s));
  try {
    let rollouts = {};
    for (;;) {
      rollouts = Object.fromEntries(known.map((s) => [s, kget(config.namespace, 'rollout', s)]));
      if (!known.some((s) => unfinished(rollouts[s], after[s])) || Date.now() >= deadline) break;
      await sleep(30_000);
    }
    const runs = known.length ? kget(config.namespace, 'analysisruns').items : [];
    const pods = known.length ? kget(config.namespace, 'pods').items : [];
    for (const s of known) {
      const rollout = rolloutCheck(s, rollouts[s], after[s]);
      checks.push(rollout);
      if (unfinished(rollouts[s], after[s])) notYet.add(rollout.name);
      if (!rollout.pass && !aborted(rollouts[s])) continue;
      const analysis = analysisCheck(s, rollouts[s], runs);
      checks.push(analysis.check);
      evidence.push(...analysis.evidence);
      if (!rollout.pass) continue;
      const hash = rollouts[s].status.currentPodHash;
      checks.push(podsCheck(s, pods, hash, after[s]));
      const { smoke: path, metrics } = config.services[s];
      const before = metrics ? sum(counted(config, hash)) : 0;
      const sent = flags['no-smoke'] ? [] : await smoke(config.host + path);
      if (!flags['no-smoke']) checks.push(smokeCheck(s, path, sent));
      if (!metrics) continue;
      // A scrape can be a minute behind the requests just sent, and the
      // pods are scraped one at a time: wait until all of them are counted.
      let byCode = counted(config, hash);
      for (let i = 0; i < 9 && sum(byCode) < Math.max(before + sent.length, 1); i++) {
        await sleep(20_000);
        byCode = counted(config, hash);
      }
      checks.push(servedCheck(s, hash, byCode, { before, sent: sent.length }));
    }
  } catch (e) {
    checks.push({ name: 'cluster', pass: false, detail: `Could not read the cluster: ${e.message}` });
  }

  const r = record({
    stage: 'rollout', ticket: flags.ticket, round: Number(flags.round ?? 1),
    inputs: { commit: flags.commit, ...Object.fromEntries(known.map((s) => [s, short(after[s])])) },
    agent: { name: 'check-rollout', kind: 'deterministic' },
    checks, evidence,
    pass: 'Live: advance to Outcome',
    fail: checks.every((c) => c.pass || notYet.has(c.name)) ? 'Not finished yet: run this round again' : 'Not live as merged: find out why before anything else ships',
  });
  const code = emit(r, flags);
  return code === 1 && r.decision.startsWith('Not finished') ? 3 : code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv);
