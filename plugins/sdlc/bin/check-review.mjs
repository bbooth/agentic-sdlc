#!/usr/bin/env node
// The Adversarial review gate, the last one before a PR. Each scope the
// diff touches gets its own reviewer, a judge tries to refute every
// blocking finding, and this checks the result: the code is what Verify
// passed, every scope was reviewed, and no blocking finding survived.
// Exits 1 when the gate fails.
//
//   node bin/check-review.mjs --scopes [--base origin/main]
//   node bin/check-review.mjs --ticket ABC-12 --reviews reviews.json
//        [--base origin/main] [--branch name] [--round 2] [--write] [--comment]
//
// --scopes prints the reviewers this diff needs. --write also saves the
// record under .sdlc/records/<ticket>/.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { branchName, priorGate } from './check-verify.mjs';
import { config, emit, matchesAny, parseArgs, patterns, record, requireConfig } from './lib.mjs';

// Nobody reviews generated code, lockfiles, records or prose.
const SKIPPED = [...patterns(config.generated?.paths), ...patterns(config.unreviewed), /^docs\//, /\.md$/];

// Each scope, the agent that reviews it, and the paths that call for it.
export const SCOPES = (config.reviewScopes ?? []).map((s) => ({ ...s, paths: patterns(s.paths) }));

export function requiredScopes(files) {
  const reviewed = files.filter((f) => !matchesAny(SKIPPED, f));
  return SCOPES.filter((s) => reviewed.some((f) => matchesAny(s.paths, f)));
}

// One list of findings, each tagged with its scope. A blocking finding the
// judge refuted is dismissed with the judge's reason; everything else is open.
export function flatten(reviews) {
  return reviews.flatMap((r) => (r.findings ?? []).map((f) => {
    const refuted = f.severity === 'blocking' && f.judged === 'refuted' && f.reason;
    return {
      severity: f.severity, summary: f.summary, status: refuted ? 'dismissed' : 'open', scope: r.scope,
      ...(f.reason ? { reason: f.reason } : {}), ...(f.judged ? { judged: f.judged } : {}),
    };
  }));
}

// The checks that need only the reviews file. `required` is requiredScopes()
// for the diff; `head` is the commit being gated.
export function reviewChecks({ required, review, head }) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });
  const reviews = review.reviews ?? [];
  const findings = flatten(reviews);

  const judged = String(review.commit ?? '');
  const same = judged.length >= 7 && (head.startsWith(judged) || judged.startsWith(head));
  add('reviewed_commit', same, same ? `The reviewers read ${head}` : `The reviewers read "${judged}", and the branch is at ${head}`);

  const missing = required.filter((s) => !reviews.some((r) => r.scope === s.name && Array.isArray(r.findings))).map((s) => s.name);
  add('scopes_covered', missing.length === 0,
    missing.length ? `No review for: ${missing.join(', ')}` : required.length ? `Reviewed for ${required.map((s) => s.name).join(', ')}` : 'Nothing here needs a scoped review');

  const vague = findings.filter((f) => !['blocking', 'minor'].includes(f.severity) || !/^[\w./@-]+:\d+/.test(f.summary ?? ''));
  add('findings_located', vague.length === 0,
    vague.length ? `A finding is blocking or minor and starts with file:line: ${vague.map((f) => `${f.scope} "${String(f.summary).slice(0, 60)}"`).join('; ')}` : `${findings.length} findings, each at a file and line`);

  const blocking = findings.filter((f) => f.severity === 'blocking');
  const unjudged = blocking.filter((f) => !['confirmed', 'refuted'].includes(f.judged) || (f.judged === 'refuted' && !f.reason));
  add('blocking_judged', unjudged.length === 0,
    unjudged.length ? `${unjudged.length} blocking findings the judge hasn't confirmed, or refuted with a reason` : `${blocking.length} blocking findings, each judged`);

  const standing = blocking.filter((f) => f.status === 'open');
  add('no_blocking_findings', standing.length === 0,
    standing.length ? `${standing.length} stand: ${standing.map((f) => `[${f.scope}] ${f.summary}`).join('; ')}`.slice(0, 1200)
      : `${blocking.length} blocking findings refuted, ${findings.length - blocking.length} minor carried to the PR`);

  return checks;
}

const git = (...args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

function main(argv) {
  requireConfig();
  const { flags } = parseArgs(argv, ['--ticket', '--reviews', '--base', '--branch', '--round']);
  const files = () => git('diff', '--name-only', git('merge-base', flags.base ?? 'origin/main', 'HEAD'), 'HEAD').split('\n').filter(Boolean);
  if (flags.scopes) {
    console.log(JSON.stringify(requiredScopes(files()).map(({ name, agent }) => ({ scope: name, agent })), null, 2));
    return 0;
  }
  if (!flags.ticket || !flags.reviews) {
    console.error('usage: check-review.mjs --scopes | --ticket ID --reviews file.json [--base origin/main] [--branch name] [--round N] [--write] [--comment]');
    return 2;
  }
  const root = git('rev-parse', '--show-toplevel');
  const review = JSON.parse(readFileSync(flags.reviews, 'utf8'));
  const head = git('rev-parse', '--short', 'HEAD');
  const dirty = git('status', '--porcelain') !== '';

  const verify = priorGate(root, flags.ticket, 'verify', 'Verify');
  const checks = [...verify.checks];
  checks.push({ name: 'committed', pass: !dirty, detail: dirty ? 'Uncommitted changes: the record must name the commit it judged' : `Clean at ${head}` });
  checks.push(...reviewChecks({ required: requiredScopes(files()), review, head }));

  const r = record({
    stage: 'adversarial_review', ticket: flags.ticket, round: Number(flags.round ?? 1),
    inputs: { branch: branchName(flags.branch), commit: head, ...(verify.file ? { verify_record: verify.file } : {}) },
    agent: { name: 'check-review', kind: 'deterministic' },
    checks, findings: flatten(review.reviews ?? []),
    pass: 'Open the PR and advance to PR review', fail: 'Back to Build: fix what stands, then Build, Verify and review again',
  });
  if (flags.write) {
    const dir = join(root, '.sdlc/records', flags.ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `adversarial_review-${r.round}.json`), JSON.stringify(r, null, 2) + '\n', { flag: 'wx' });
  }
  return emit(r, flags);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv);
