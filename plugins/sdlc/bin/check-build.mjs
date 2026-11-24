#!/usr/bin/env node
// The Build gate. Run on a task's branch when the author thinks it's done:
// it reads the diff against main, runs each touched area's commands from
// CLAUDE.md, folds in the task reviewer's findings, and prints a gate record.
// Exits 1 when the gate fails.
//
//   node bin/check-build.mjs --ticket ABC-12 --size M [--findings findings.json]
//        [--base origin/main] [--round 2] [--no-run] [--write] [--comment]
//
// --write also saves the record under .sdlc/records/<ticket>/.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, emit, matchesAny, parseArgs, patterns, record, requireConfig } from './lib.mjs';

const PREFIXES = config.branchPrefixes ?? [];
// Lines added plus removed, not counting generated files or lockfiles. Past
// this a task is more than one PR's review. Lockfiles still get reviewed.
const SIZE_LIMITS = { S: 300, M: 800 };
const LOCKFILES = /(^|\/)(Cargo\.lock|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|go\.sum|go\.work\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock)$/;
const UNCOUNTED = [LOCKFILES, ...patterns([...(config.generated?.paths ?? []), ...(config.unreviewed ?? [])])];
const TESTS = patterns(config.tests);
const STORE_CODE = patterns(config.storeCode);
const STORE_TESTS = patterns(config.storeTests);

const isTest = (f) => matchesAny(TESTS, f);
// Source files that need a test changed with them. The default suits a Go
// and TypeScript repo; a project in another language sets `code`.
const CODE = config.code ? patterns(config.code) : [/\.(go|vue|ts|mjs|sql)$/];
const isCode = (f) => !isTest(f) && matchesAny(CODE, f) && !matchesAny(UNCOUNTED, f);

// The areas a diff touches, each with its commands from the config. An area
// with `dockerTests` runs `go test -short` where there is no Docker; one
// that `requires` a path isn't run without it.
export function areas(files, { docker = true, has = () => true } = {}) {
  return (config.areas ?? []).filter((a) => files.some((f) => matchesAny(patterns(a.when), f))).map((a) => ({
    name: a.name,
    cwd: a.cwd,
    commands: a.commands.map((c) => (a.dockerTests && !docker ? c.replace(/^go test /, 'go test -short ') : c)),
    ...(a.env ? { env: a.env } : {}),
    ...(a.tool ? { tool: a.tool } : {}),
    ...(a.dockerTests ? { short: !docker } : {}),
    ...(a.requires ? { unavailable: has(a.requires) ? null : `${a.requires} is not installed` } : {}),
  }));
}

// The checks that need only the diff. `changes` is [{ file, lines, added }];
// `added` is true for a file the branch creates.
export function diffChecks({ branch, changes, size }) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });
  const files = changes.map((c) => c.file);

  const prefixed = PREFIXES.some((p) => branch.startsWith(p));
  add('branch', prefixed, prefixed ? branch : `"${branch}" needs a prefix: ${PREFIXES.join(', ')}`);
  add('has_changes', files.length > 0, `${files.length} files changed`);

  const code = files.filter(isCode);
  const tests = files.filter(isTest);
  add('tests_changed', code.length === 0 || tests.length > 0,
    code.length === 0 ? 'No code changed' : tests.length ? `${tests.length} test files changed with ${code.length} code files` : `${code.length} code files changed and no test`);

  // Fake stores don't catch SQL mistakes: SQL needs a test against the real database.
  const sql = files.filter((f) => matchesAny(STORE_CODE, f)).filter((f) => !isTest(f));
  const storeTests = files.filter((f) => matchesAny(STORE_TESTS, f));
  add('sql_has_store_test', sql.length === 0 || storeTests.length > 0,
    sql.length === 0 ? 'No SQL changed' : storeTests.length ? `${storeTests.length} store test files changed` : 'SQL changed without a store test against Postgres');

  const ups = changes.filter((c) => c.added && /\.up\.sql$/.test(c.file)).map((c) => c.file);
  const unpaired = ups.filter((u) => !files.includes(u.replace(/\.up\.sql$/, '.down.sql')));
  add('migrations_paired', unpaired.length === 0, unpaired.length ? `No down migration for: ${unpaired.join(', ')}` : `${ups.length} new migrations, each with its down`);

  for (const g of config.generatedWith ?? []) {
    const source = files.some((f) => new RegExp(g.source).test(f));
    const regenerated = files.some((f) => new RegExp(g.generated).test(f));
    add(g.check ?? 'generated_with_source', !source || regenerated, !source ? g.none : regenerated ? g.ok : g.missing);
  }

  const status = config.statusFile;
  if (status) add('status_updated', files.includes(status), files.includes(status) ? `${status} changed` : `${status} is updated in the same PR as the work`);

  const lines = changes.filter((c) => !UNCOUNTED.some((re) => re.test(c.file))).reduce((n, c) => n + c.lines, 0);
  if (size in SIZE_LIMITS) add('size', lines <= SIZE_LIMITS[size], `${lines} lines changed; size ${size} allows ${SIZE_LIMITS[size]}`);
  else add('size', false, 'Pass the task\'s size: --size S or --size M');

  return checks;
}

// The reviewer's findings as one check: an open blocking finding fails the gate.
export function findingsCheck(findings) {
  const open = findings.filter((f) => f.severity === 'blocking' && f.status === 'open');
  return {
    name: 'no_blocking_findings',
    pass: open.length === 0,
    detail: open.length ? `${open.length} open: ${open.map((f) => f.summary).join('; ')}` : `${findings.length} findings, none blocking and open`,
  };
}

const git = (...args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
};
const has = (cmd, args = ['--version']) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;

function gather(base) {
  const mergeBase = git('merge-base', base, 'HEAD');
  const added = new Set(git('diff', '--name-only', '--diff-filter=A', mergeBase, 'HEAD').split('\n').filter(Boolean));
  const changes = git('diff', '--numstat', mergeBase, 'HEAD').split('\n').filter(Boolean).map((l) => {
    const [a, d, file] = l.split('\t');
    return { file, lines: (Number(a) || 0) + (Number(d) || 0), added: added.has(file) };
  });
  return { branch: git('rev-parse', '--abbrev-ref', 'HEAD'), commit: git('rev-parse', '--short', 'HEAD'), dirty: git('status', '--porcelain') !== '', changes };
}

function runArea(area, root) {
  if (area.unavailable) return { pass: false, detail: `Not run: ${area.unavailable}` };
  if (area.tool && !has(area.tool)) return { pass: false, detail: `Not run: ${area.tool} is not installed` };
  for (const command of area.commands) {
    const r = spawnSync(command, { cwd: join(root, area.cwd), shell: true, encoding: 'utf8', env: { ...process.env, ...area.env }, timeout: 15 * 60_000, maxBuffer: 64 << 20 });
    if (r.status !== 0) return { pass: false, detail: `${command} failed: ${`${r.stdout}${r.stderr}`.trim().split('\n').slice(-6).join(' | ').slice(0, 600)}` };
  }
  return { pass: true, detail: area.commands.join(' && ') };
}

function main(argv) {
  requireConfig();
  const { flags } = parseArgs(argv, ['--ticket', '--size', '--findings', '--base', '--round']);
  if (!flags.ticket) {
    console.error('usage: check-build.mjs --ticket ID --size S|M [--findings file.json] [--base origin/main] [--round N] [--no-run] [--write] [--comment]');
    return 2;
  }
  const root = git('rev-parse', '--show-toplevel');
  const state = gather(flags.base ?? 'origin/main');
  const checks = diffChecks({ branch: state.branch, changes: state.changes, size: flags.size });
  checks.push({ name: 'committed', pass: !state.dirty, detail: state.dirty ? 'Uncommitted changes: the record must name the commit it judged' : `Clean at ${state.commit}` });

  const findings = flags.findings ? JSON.parse(readFileSync(flags.findings, 'utf8')) : [];
  if (!flags['no-run']) {
    const docker = has('docker', ['info']);
    const touched = areas(state.changes.map((c) => c.file), { docker, has: (p) => existsSync(join(root, p)) });
    for (const area of touched) {
      checks.push({ name: `commands:${area.name}`, ...runArea(area, root) });
      // Not a failure here, but nobody should read this record as "store tests passed".
      if (area.short) findings.push({ severity: 'minor', status: 'open', summary: `${area.name}: Docker-backed tests were not run (no Docker); Verify must see them pass in CI` });
    }
  }
  checks.push(flags.findings ? findingsCheck(findings) : { name: 'no_blocking_findings', pass: false, detail: 'No reviewer findings: run the task-reviewer and pass --findings' });

  const r = record({
    stage: 'build', ticket: flags.ticket, round: Number(flags.round ?? 1),
    inputs: { branch: state.branch, commit: state.commit },
    agent: { name: 'check-build', kind: 'deterministic' },
    checks, findings,
    pass: 'Advance to Verify', fail: 'Stay in Build: fix and re-run',
  });
  if (flags.write) {
    const dir = join(root, '.sdlc/records', flags.ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `build-${r.round}.json`), JSON.stringify(r, null, 2) + '\n', { flag: 'wx' });
  }
  return emit(r, flags);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv);
