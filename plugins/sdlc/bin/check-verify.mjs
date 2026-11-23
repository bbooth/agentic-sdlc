#!/usr/bin/env node
// The Verify gate. Run on a task's branch after its Build gate passed and
// the verifier agent has tried each acceptance criterion: it checks that
// the verifier judged the code the Build gate passed, that every criterion
// is met with evidence someone could repeat, and re-runs the tests the
// verifier named. Exits 1 when the gate fails.
//
//   node bin/check-verify.mjs --ticket ABC-12 --criteria AC-1,AC-2 --verification v.json
//        [--base origin/main] [--branch name] [--round 2] [--no-run] [--write] [--comment]
//
// --write also saves the record under .sdlc/records/<ticket>/.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findingsCheck } from './check-build.mjs';
import { config, emit, matchesAny, parseArgs, patterns, record, requireConfig } from './lib.mjs';

// Evidence that shows behavior. Reading the code ("inspection") supports a
// verdict but never carries one.
const OBSERVED = ['test', 'e2e', 'browser'];
const KINDS = [...OBSERVED, 'inspection'];
// The only commands the gate will run from a verification file. They run
// without a shell, so quoting is all the syntax a command can use.
const RUNNABLE = ['go test', 'npm test', 'npx vitest run', 'node --test'];
export const argv = (command) => (command.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((a) => a.replace(/^(['"])(.*)\1$/, '$2'));

// What CLAUDE.md's Verification section asks for beyond tests, by what the
// diff touches: the config's `evidence` maps each kind to the paths that need it.
const TESTS = patterns(config.tests);
const NEEDS = Object.entries(config.evidence ?? {}).map(([kind, paths]) => [kind, patterns(paths)]);
export function required(files) {
  const src = files.filter((f) => !matchesAny(TESTS, f));
  return NEEDS.filter(([, res]) => src.some((f) => matchesAny(res, f))).map(([kind]) => kind);
}

// The checks that need only the verification file. `criteria` is the list
// the ticket covers; `head` is the commit being gated.
export function verificationChecks({ criteria, verification, head, files }) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });
  const entries = verification.criteria ?? [];
  const evidence = entries.flatMap((c) => (c.evidence ?? []).map((e) => ({ ...e, id: c.id })));

  const judged = String(verification.commit ?? '');
  const same = judged.length >= 7 && (head.startsWith(judged) || judged.startsWith(head));
  add('verified_commit', same, same ? `The verifier judged ${head}` : `The verifier judged "${judged}", and the branch is at ${head}`);

  const missing = criteria.filter((id) => !entries.some((c) => c.id === id));
  add('criteria_covered', criteria.length > 0 && missing.length === 0,
    criteria.length === 0 ? 'Pass the criteria the ticket covers: --criteria AC-1,AC-2' : missing.length ? `No verdict for: ${missing.join(', ')}` : `A verdict for each of ${criteria.join(', ')}`);

  const unmet = entries.filter((c) => criteria.includes(c.id) && c.verdict !== 'met');
  add('criteria_met', missing.length === 0 && unmet.length === 0,
    unmet.length ? unmet.map((c) => `${c.id} is ${c.verdict ?? 'not judged'}${c.notes ? ` (${c.notes})` : ''}`).join('; ') : 'Every criterion is met');

  const malformed = evidence.filter((e) => !KINDS.includes(e.kind) || !e.ref || !e.observed);
  const thin = entries.filter((c) => !(c.evidence ?? []).some((e) => OBSERVED.includes(e.kind)));
  add('evidence', malformed.length === 0 && thin.length === 0,
    malformed.length ? `Evidence needs a kind (${KINDS.join(', ')}), a ref and what was observed: ${malformed.map((e) => e.id).join(', ')}`
      : thin.length ? `Only read, never run: ${thin.map((c) => c.id).join(', ')}` : `${evidence.length} pieces of evidence, each criterion observed running`);

  const need = required(files);
  const lacking = need.filter((kind) => !evidence.some((e) => e.kind === kind));
  add('end_to_end', lacking.length === 0,
    lacking.length ? `The diff needs ${lacking.join(' and ')} evidence (CLAUDE.md, Verification) and has none` : need.length ? `Has ${need.join(' and ')} evidence, which this diff needs` : 'Nothing here needs more than tests');

  return checks;
}

// "path/file_test.go:TestName" must name a test that is in the repo.
export function testExists(ref, read) {
  const [file, name] = ref.split(':');
  if (!file || !name) return 'ref is "path/to/test_file:TestName"';
  const text = read(file);
  if (text === null) return `${file} does not exist`;
  return text.includes(name) ? null : `${file} has no "${name}"`;
}

// A named test's output must show it ran and passed, not that it was skipped.
export function ranAndPassed(command, status, output) {
  if (status !== 0) return `failed: ${output.trim().split('\n').slice(-6).join(' | ').slice(0, 600)}`;
  if (/no tests to run/.test(output)) return 'matched no tests';
  if (command.startsWith('go test') && /^\s*--- SKIP/m.test(output)) return 'a test was skipped';
  if (command.startsWith('go test') && !/^\s*--- PASS/m.test(output)) return 'no test reported a pass';
  return null;
}

const git = (...args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

// The latest record of the stage before this one, and whether anything but
// records changed since the commit it judged. A stage only ever judges the
// code the stage before it passed.
export function priorGate(root, ticket, stage, title) {
  const dir = join(root, '.sdlc/records', ticket);
  const rounds = existsSync(dir) ? readdirSync(dir).map((f) => f.match(new RegExp(`^${stage}-(\\d+)\\.json$`))).filter(Boolean).sort((a, b) => b[1] - a[1]) : [];
  if (rounds.length === 0) return { file: null, checks: [{ name: `${stage}_passed`, pass: false, detail: `No ${title} record in .sdlc/records/${ticket}/` }] };
  const file = `.sdlc/records/${ticket}/${rounds[0][0]}`;
  const prior = JSON.parse(readFileSync(join(root, file), 'utf8'));
  const checks = [{ name: `${stage}_passed`, pass: prior.result === 'pass', detail: `${file} says ${prior.result} at ${prior.inputs.commit}` }];
  const since = git('diff', '--name-only', prior.inputs.commit, 'HEAD').split('\n').filter((f) => f && !f.startsWith('.sdlc/records/'));
  checks.push({ name: 'same_code', pass: since.length === 0, detail: since.length ? `Changed since the ${title} gate, so the ticket goes back through Build: ${since.slice(0, 5).join(', ')}` : `Only records changed since ${prior.inputs.commit}` });
  return { file, checks };
}

// A detached checkout (the branch is out in another worktree) has no branch name of its own.
export function branchName(flag) {
  const name = flag ?? git('rev-parse', '--abbrev-ref', 'HEAD');
  return name === 'HEAD' ? 'detached; pass --branch' : name;
}

function rerun(e, root) {
  const command = String(e.command ?? '');
  if (!RUNNABLE.some((p) => command.startsWith(p + ' ')) || /-short\b/.test(command)) return `needs a command the gate can re-run (${RUNNABLE.join(', ')}), without -short`;
  const [cmd, ...args] = argv(command);
  if (cmd === 'go') args.push('-v', '-count=1');
  const r = spawnSync(cmd, args, { cwd: join(root, e.cwd ?? '.'), encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 64 << 20 });
  if (r.error) return `could not run: ${r.error.message}`;
  return ranAndPassed(command, r.status, `${r.stdout}${r.stderr}`);
}

function main(argv) {
  requireConfig();
  const { flags } = parseArgs(argv, ['--ticket', '--criteria', '--verification', '--base', '--branch', '--round']);
  if (!flags.ticket || !flags.verification) {
    console.error('usage: check-verify.mjs --ticket ID --criteria AC-1,AC-2 --verification file.json [--base origin/main] [--round N] [--no-run] [--write] [--comment]');
    return 2;
  }
  const root = git('rev-parse', '--show-toplevel');
  const verification = JSON.parse(readFileSync(flags.verification, 'utf8'));
  const criteria = String(flags.criteria ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const head = git('rev-parse', '--short', 'HEAD');
  const dirty = git('status', '--porcelain') !== '';
  const files = git('diff', '--name-only', git('merge-base', flags.base ?? 'origin/main', 'HEAD'), 'HEAD').split('\n').filter(Boolean);

  const build = priorGate(root, flags.ticket, 'build', 'Build');
  const checks = [...build.checks];
  checks.push({ name: 'committed', pass: !dirty, detail: dirty ? 'Uncommitted changes: the record must name the commit it judged' : `Clean at ${head}` });
  checks.push(...verificationChecks({ criteria, verification, head, files }));

  const tests = (verification.criteria ?? []).flatMap((c) => (c.evidence ?? []).filter((e) => e.kind === 'test').map((e) => ({ ...e, id: c.id })));
  const read = (f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : null);
  const absent = tests.map((e) => testExists(e.ref ?? '', read)).filter(Boolean);
  checks.push({ name: 'tests_exist', pass: absent.length === 0, detail: absent.length ? absent.join('; ') : `${tests.length} named tests are in the repo` });
  if (!flags['no-run']) {
    for (const e of tests) {
      const problem = rerun(e, root);
      checks.push({ name: `rerun:${e.id}`, pass: !problem, detail: problem ? `${e.ref} ${problem}` : `${e.ref} passed: ${e.command}` });
    }
  }
  const findings = verification.findings ?? [];
  checks.push(findingsCheck(findings));

  const r = record({
    stage: 'verify', ticket: flags.ticket, round: Number(flags.round ?? 1),
    inputs: { branch: branchName(flags.branch), commit: head, ...(build.file ? { build_record: build.file } : {}) },
    agent: { name: 'check-verify', kind: 'deterministic' },
    checks, findings,
    evidence: (verification.criteria ?? []).flatMap((c) => (c.evidence ?? []).map((e) => `${c.id} ${e.kind} ${e.ref}: ${e.observed}`)),
    pass: 'Advance to Adversarial review', fail: 'Back to Build: fix, pass the Build gate again, then re-verify',
  });
  if (flags.write) {
    const dir = join(root, '.sdlc/records', flags.ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `verify-${r.round}.json`), JSON.stringify(r, null, 2) + '\n', { flag: 'wx' });
  }
  return emit(r, flags);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv);
