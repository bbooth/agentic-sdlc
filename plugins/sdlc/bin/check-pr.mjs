#!/usr/bin/env node
// The PR review gate, run by CI on every pull request. The earlier gates
// ran wherever the ticket was built; this is the one place that checks,
// on the code GitHub would merge, that they ran and that this is still
// the change they passed. Exits 1 when the gate fails.
//
//   node bin/check-pr.mjs --event "$GITHUB_EVENT_PATH" [--base origin/main] [--round 2] [--comment]
//   node bin/check-pr.mjs --title "..." --body-file body.md [--labels a,b] [--pr 12] ...
//
// Run it standing on the PR's head commit, with the base branch's history
// fetched. It writes no file: the record goes on the ticket.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, emit, matchesAny, parseArgs, patterns, record, requireConfig, sections } from './lib.mjs';

const RECORDS = /^\.sdlc\/records\/([^/]+)\//;
// A change to what ships needs a ticket. The pipeline's own files, docs
// and CI don't.
const SHIPS = patterns(config.ships);
export const NO_TICKET = 'no-ticket';
const STAGES = [['build', 'Build'], ['verify', 'Verify'], ['adversarial_review', 'Adversarial review']];

export const ticketsIn = (files) => [...new Set(files.map((f) => f.match(RECORDS)?.[1]).filter(Boolean))];
export const shipped = (files) => files.filter((f) => matchesAny(SHIPS, f));

// The latest round of one stage's record for a ticket, or null.
export function latest(root, ticket, stage) {
  const dir = join(root, '.sdlc/records', ticket);
  const rounds = existsSync(dir) ? readdirSync(dir).map((f) => f.match(new RegExp(`^${stage}-(\\d+)\\.json$`))).filter(Boolean).sort((a, b) => b[1] - a[1]) : [];
  if (rounds.length === 0) return null;
  return { file: `.sdlc/records/${ticket}/${rounds[0][0]}`, fileRound: Number(rounds[0][1]), ...JSON.parse(readFileSync(join(dir, rounds[0][0]), 'utf8')) };
}

// `records` maps each stage to latest(); `statuses` is `git diff
// --name-status` for the record files, as [status, path] pairs.
export function recordChecks({ ticket, records, statuses }) {
  const checks = [];
  for (const [stage, title] of STAGES) {
    const r = records[stage];
    const mislabeled = r && (r.stage !== stage || r.ticket !== ticket || r.round !== r.fileRound);
    let detail = `${r?.file} says ${r?.result} at ${r?.inputs?.commit}`;
    if (!r) detail = `No ${title} record in .sdlc/records/${ticket}/`;
    else if (mislabeled) detail = `${r.file} is a record of ${r.stage} round ${r.round} for ${r.ticket}`;
    checks.push({ name: `${stage}_passed`, pass: Boolean(r) && !mislabeled && r.result === 'pass', detail });
  }
  const rewritten = statuses.filter(([s]) => s !== 'A').map(([s, f]) => `${s} ${f}`);
  checks.push({
    name: 'records_append_only', pass: rewritten.length === 0,
    detail: rewritten.length ? `A record is only ever added: ${rewritten.join(', ')}` : `${statuses.length} records added, none changed or removed`,
  });
  return checks;
}

// `reviewed` and `head` are fingerprints of the change (the diff against
// the base without records), which stay the same when main is merged in.
export function sameChange({ commit, reviewed, head }) {
  const pass = Boolean(reviewed) && reviewed === head;
  let detail = `The change is the one reviewed at ${commit}; only records, or a merge of the base, came after`;
  if (!reviewed) detail = `The reviewed commit ${commit} isn't in this branch's history`;
  else if (!pass) detail = `The change differs from the one reviewed at ${commit}, so the ticket goes back through Build`;
  return { name: 'same_change', pass, detail };
}

const boxes = (text) => (text.match(/^[-*] \[[ xX]\] +\S/gm) ?? []).length;

// `minor` is how many minor findings the Verify and review records left open.
export function bodyChecks({ ticket, title, body, minor }) {
  const checks = [];
  const s = sections(body);
  const named = `${title}\n${body}`.includes(ticket);
  checks.push({ name: 'names_ticket', pass: named, detail: named ? `Names ${ticket}` : `Neither the title nor the body names ${ticket}` });

  const missing = ['Summary', 'Test plan'].filter((h) => !(s[h] ?? '').trim());
  const plan = boxes(s['Test plan'] ?? '');
  const shaped = missing.length === 0 && plan > 0;
  checks.push({
    name: 'body_shape', pass: shaped,
    detail: missing.length ? `Missing section: ${missing.join(', ')}` : plan === 0 ? 'The Test plan has no checklist' : `Summary, and a Test plan of ${plan} items`,
  });

  const listed = boxes(s['Open findings'] ?? '');
  checks.push({
    name: 'findings_listed', pass: listed >= minor,
    detail: listed >= minor ? (minor ? `${listed} items under Open findings for ${minor} open minor findings` : 'No minor findings were left open')
      : `The records leave ${minor} minor findings open, and Open findings lists ${listed}`,
  });
  return checks;
}

const git = (args, input) => {
  const r = spawnSync('git', args, { encoding: 'utf8', input, maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

// git's own fingerprint of a diff: line numbers and whitespace don't count.
function fingerprint(base, commit) {
  if (spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`]).status !== 0) return null;
  const diff = git(['diff', git(['merge-base', base, commit]), commit, '--', '.', ':(exclude).sdlc/records']);
  return git(['patch-id', '--stable'], diff + '\n').split(' ')[0] || 'empty';
}

function main(argv) {
  requireConfig();
  const { flags } = parseArgs(argv, ['--event', '--title', '--body-file', '--labels', '--pr', '--base', '--round']);
  let pr;
  if (flags.event) {
    const e = JSON.parse(readFileSync(flags.event, 'utf8')).pull_request;
    pr = { number: e.number, title: e.title ?? '', body: e.body ?? '', labels: (e.labels ?? []).map((l) => l.name) };
  } else if (typeof flags.title === 'string' && flags['body-file']) {
    pr = { number: flags.pr ?? '?', title: flags.title, body: readFileSync(flags['body-file'], 'utf8'), labels: String(flags.labels ?? '').split(',').filter(Boolean) };
  } else {
    console.error('usage: check-pr.mjs --event event.json | --title T --body-file F [--labels a,b] [--pr N]  [--base origin/main] [--round N] [--comment]');
    return 2;
  }
  const root = git(['rev-parse', '--show-toplevel']);
  const base = flags.base ?? 'origin/main';
  const head = git(['rev-parse', '--short', 'HEAD']);
  const range = [git(['merge-base', base, 'HEAD']), 'HEAD'];
  const files = git(['diff', '--name-only', ...range]).split('\n').filter(Boolean);
  const tickets = ticketsIn(files);

  if (tickets.length === 0) {
    const code = shipped(files);
    if (code.length === 0) { console.log('Not a ticket\'s PR, and it changes nothing that ships: no gate to pass.'); return 0; }
    if (pr.labels.includes(NO_TICKET)) { console.log(`Labelled ${NO_TICKET}: this change skips the ticket pipeline on the owner's say.`); return 0; }
    console.error(`This PR changes what ships (${code.slice(0, 5).join(', ')}) and carries no gate records.\nTake it through the pipeline as a ticket, or label it ${NO_TICKET}.`);
    return 1;
  }
  if (tickets.length > 1) { console.error(`One ticket per PR; this one carries records for ${tickets.join(', ')}.`); return 1; }

  const [ticket] = tickets;
  const records = Object.fromEntries(STAGES.map(([stage]) => [stage, latest(root, ticket, stage)]));
  const statuses = git(['diff', '--name-status', ...range, '--', '.sdlc/records']).split('\n').filter(Boolean).map((l) => l.split('\t'));
  const reviewed = records.adversarial_review?.inputs?.commit;
  const minor = ['verify', 'adversarial_review'].flatMap((s) => records[s]?.findings ?? []).filter((f) => f.severity === 'minor' && f.status === 'open').length;

  const checks = recordChecks({ ticket, records, statuses });
  if (reviewed) checks.push(sameChange({ commit: reviewed, reviewed: fingerprint(base, reviewed), head: fingerprint(base, 'HEAD') }));
  checks.push(...bodyChecks({ ticket, title: pr.title, body: pr.body, minor }));

  const r = record({
    stage: 'pr_review', ticket, round: Number(flags.round ?? 1),
    inputs: { pr: `#${pr.number}`, commit: head, ...(reviewed ? { reviewed_commit: reviewed } : {}) },
    agent: { name: 'check-pr', kind: 'deterministic' },
    checks,
    findings: ['verify', 'adversarial_review'].flatMap((s) => records[s]?.findings ?? []).filter((f) => f.status === 'open'),
    pass: 'Ready for the owner: merge once the other checks are green',
    fail: 'Not mergeable as a ticket: fix the PR, or go back to Build if the change itself differs',
  });
  return emit(r, flags);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { process.exitCode = main(process.argv); } catch (e) { console.error(e.message); process.exitCode = 2; }
}
