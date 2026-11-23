#!/usr/bin/env node
// Claude Code hook: the checks that run on every file edit, so a problem is
// caught in seconds instead of at review. Wired up in the plugin's hooks/hooks.json.
//
//   PreToolUse  (--pre): refuses edits that should never be made by hand.
//   PostToolUse:         formats-and-vets the file just written.
//
// Exit 2 with a message on stderr is how a hook tells Claude what to fix.
// A tool that isn't installed is skipped: the Build gate and CI run the
// full checks, this is only the fast loop.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, matchesAny, patterns, projectRoot } from './lib.mjs';

const GENERATED = patterns(config.generated?.paths);
const MIGRATION = config.migrations ? new RegExp(config.migrations) : null;

// Why an edit to `rel` is refused, or null. `exists` is whether the file is already there.
export function refusal(rel, exists) {
  if (matchesAny(GENERATED, rel)) {
    return `${rel} is generated. Change its source, then run: ${config.generated.regenerate}`;
  }
  if (/^\.sdlc\/records\/.+\.json$/.test(rel) && exists) {
    return `${rel} is a gate record, and records are append-only. A new round is a new file.`;
  }
  if (MIGRATION?.test(rel) && exists && committed(rel)) {
    return `${rel} is a migration that's already on main. Add a new migration instead of changing it.`;
  }
  return null;
}

function committed(rel) {
  return spawnSync('git', ['cat-file', '-e', `origin/main:${rel}`], { stdio: 'ignore' }).status === 0;
}

// The checks to run after `rel` was written: [{ name, cmd, args, cwd, env }].
export function checksFor(rel, root) {
  const abs = join(root, rel);
  if (matchesAny(GENERATED, rel)) return [];
  if (rel.endsWith('.go')) {
    const mod = nearest(dirname(abs), 'go.mod', root);
    if (!mod) return [];
    // A module outside go.work builds with GOWORK=off.
    const env = (config.goWorkOff ?? []).includes(relative(root, mod)) ? { GOWORK: 'off' } : {};
    return [
      { name: 'gofmt', cmd: 'gofmt', args: ['-l', abs], cwd: root, failOnOutput: true, fix: `gofmt -w ${rel}` },
      { name: 'go vet', cmd: 'go', args: ['vet', './' + relative(mod, dirname(abs))], cwd: mod, env },
    ];
  }
  // The config's own checks: `{file}` is the edited file, relative to `cwd`.
  for (const c of config.onEdit ?? []) {
    if (!new RegExp(c.when).test(rel)) continue;
    if (c.requires && !existsSync(join(root, c.requires))) return [];
    const cwd = join(root, c.cwd ?? '.');
    return [{ name: c.name, cmd: c.cmd, args: c.args.map((a) => a.replace('{file}', relative(cwd, abs))), cwd }];
  }
  const up = MIGRATION?.test(rel) && rel.match(/^(.+)\.up\.sql$/);
  if (up) return [{ name: 'down migration', missing: `${up[1]}.down.sql` }];
  return [];
}

function nearest(dir, file, root) {
  for (let d = dir; d.startsWith(root); d = dirname(d)) {
    if (existsSync(join(d, file))) return d;
    if (d === root) break;
  }
  return null;
}

function run(check, root) {
  if (check.missing) {
    return existsSync(join(root, check.missing)) ? null : `Every up migration needs its down: ${check.missing} doesn't exist yet.`;
  }
  const r = spawnSync(check.cmd, check.args, { cwd: check.cwd, env: { ...process.env, ...check.env }, encoding: 'utf8', timeout: 90_000 });
  if (r.error) return null; // not installed, or too slow for the fast loop
  const out = `${r.stdout}${r.stderr}`.trim();
  if (check.failOnOutput ? out : r.status !== 0) return `${check.name} failed${check.fix ? ` (fix: ${check.fix})` : ''}:\n${out.slice(0, 4000)}`;
  return null;
}

function main(argv) {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { return 0; }
  const file = input?.tool_input?.file_path;
  if (!file) return 0;
  const root = projectRoot();
  const rel = relative(root, resolve(root, file));
  if (rel.startsWith('..')) return 0;

  if (argv.includes('--pre')) {
    const why = refusal(rel, existsSync(join(root, rel)));
    if (why) { console.error(why); return 2; }
    return 0;
  }
  const failures = checksFor(rel, root).map((c) => run(c, root)).filter(Boolean);
  if (failures.length) { console.error(failures.join('\n\n')); return 2; }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv);
