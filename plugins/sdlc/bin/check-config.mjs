#!/usr/bin/env node
// Checks a project's .sdlc/config.json (and .sdlc/rollout.json, if it has
// one) before the gates rely on it: the keys the gates read are there,
// every pattern compiles, and each reviewer scope names an agent this
// plugin has. Run by `onboard-project` and by CI in a project that wants it.
// Exits 1 on an error; a warning (a path that doesn't exist yet, as in a new
// repo) doesn't fail unless --strict.
//
//   node bin/check-config.mjs [config.json] [--rollout rollout.json] [--strict]

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, projectRoot } from './lib.mjs';

const AGENTS = join(dirname(fileURLToPath(import.meta.url)), '../agents');
export const agentNames = () => readdirSync(AGENTS).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));

// [{ level: 'error' | 'warn' | 'ok', detail }]. `exists` says whether a
// repo-relative path is there.
export function checkConfig(c, { exists = () => true, agents = agentNames() } = {}) {
  const out = [];
  const error = (detail) => out.push({ level: 'error', detail });
  const warn = (detail) => out.push({ level: 'warn', detail });
  const isList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const compiles = (where, p) => {
    try { new RegExp(p); } catch (e) { error(`${where}: "${p}" is not a regular expression (${e.message})`); }
  };
  const patterns = (where, v, { required = false } = {}) => {
    if (v === undefined) { if (required) error(`${where} is missing`); return; }
    if (!isList(v)) { error(`${where} must be a list of patterns`); return; }
    if (required && v.length === 0) warn(`${where} is empty`);
    v.forEach((p) => compiles(where, p));
  };

  const t = c.tracker;
  if (!t || typeof t !== 'object') error('tracker is missing: kind, team, key and project');
  else {
    for (const k of ['kind', 'team', 'key', 'project']) if (typeof t[k] !== 'string' || !t[k]) error(`tracker.${k} is missing`);
    if (t.key && !/^[A-Z][A-Z0-9]*$/.test(t.key)) error(`tracker.key "${t.key}" must be the ticket prefix in capitals, e.g. ABC`);
  }

  if (!isList(c.branchPrefixes) || c.branchPrefixes.length === 0) error('branchPrefixes must list at least one prefix, e.g. "fix/"');
  else c.branchPrefixes.filter((p) => !p.endsWith('/')).forEach((p) => error(`branchPrefixes: "${p}" must end with /`));

  if (c.statusFile !== undefined && !exists(c.statusFile)) warn(`statusFile ${c.statusFile} doesn't exist yet; every ticket's PR must update it`);

  if (!c.generated || typeof c.generated !== 'object') error('generated is missing: { "paths": [...], "regenerate": "..." } (paths may be empty)');
  else {
    if (c.generated.paths === undefined) error('generated.paths is missing (an empty list is fine)');
    patterns('generated.paths', c.generated.paths);
    if ((c.generated.paths ?? []).length && !c.generated.regenerate) error('generated.regenerate is missing: the command the edit hook suggests instead of a hand edit');
  }
  patterns('unreviewed', c.unreviewed);
  patterns('ships', c.ships, { required: true });
  patterns('tests', c.tests, { required: true });
  patterns('code', c.code);
  patterns('storeCode', c.storeCode);
  patterns('storeTests', c.storeTests);
  if (c.migrations !== undefined) compiles('migrations', c.migrations);
  if ((c.storeCode ?? []).length && !(c.storeTests ?? []).length) error('storeCode is set without storeTests: every SQL change would fail the Build gate');

  for (const [i, g] of (c.generatedWith ?? []).entries()) {
    for (const k of ['source', 'generated']) if (typeof g[k] === 'string') compiles(`generatedWith[${i}].${k}`, g[k]); else error(`generatedWith[${i}].${k} is missing`);
    for (const k of ['none', 'ok', 'missing']) if (!g[k]) error(`generatedWith[${i}].${k} is missing: the gate check's message`);
  }

  if (!Array.isArray(c.areas) || c.areas.length === 0) error('areas must list at least one area with its commands');
  for (const [i, a] of (c.areas ?? []).entries()) {
    const where = `areas[${i}]${a.name ? ` (${a.name})` : ''}`;
    if (!a.name) error(`${where}.name is missing`);
    if (typeof a.cwd !== 'string') error(`${where}.cwd is missing`);
    else if (!exists(a.cwd)) warn(`${where}.cwd ${a.cwd} doesn't exist yet`);
    patterns(`${where}.when`, a.when, { required: true });
    if (!isList(a.commands) || a.commands.length === 0) error(`${where}.commands must list at least one command`);
    if (a.dockerTests && !(a.commands ?? []).some((cmd) => cmd.startsWith('go test '))) warn(`${where}.dockerTests only changes "go test" commands, and this area has none`);
  }

  for (const [i, e] of (c.onEdit ?? []).entries()) {
    const where = `onEdit[${i}]${e.name ? ` (${e.name})` : ''}`;
    for (const k of ['name', 'when', 'cmd']) if (!e[k]) error(`${where}.${k} is missing`);
    if (e.when) compiles(`${where}.when`, e.when);
    if (!isList(e.args ?? [])) error(`${where}.args must be a list`);
  }
  if (c.goWorkOff !== undefined && !isList(c.goWorkOff)) error('goWorkOff must be a list of module directories');

  for (const [kind, v] of Object.entries(c.evidence ?? {})) {
    if (!['e2e', 'browser'].includes(kind)) error(`evidence.${kind}: the verifier only reports e2e and browser evidence`);
    patterns(`evidence.${kind}`, v);
  }

  if (!Array.isArray(c.reviewScopes) || c.reviewScopes.length === 0) error('reviewScopes must list at least one reviewer');
  else {
    if (!c.reviewScopes.some((s) => s.name === 'security' && (s.paths ?? []).includes('.'))) warn('No security scope over every path ("."): code outside the other scopes gets no reviewer');
    for (const [i, s] of c.reviewScopes.entries()) {
      const where = `reviewScopes[${i}]${s.name ? ` (${s.name})` : ''}`;
      if (!s.name) error(`${where}.name is missing`);
      if (!agents.includes(s.agent)) error(`${where}.agent "${s.agent}" isn't one of this plugin's agents: ${agents.filter((a) => a.startsWith('review-')).join(', ')}`);
      patterns(`${where}.paths`, s.paths, { required: true });
    }
  }
  return out;
}

export function checkRollout(r, { exists = () => true } = {}) {
  const out = [];
  const error = (detail) => out.push({ level: 'error', detail });
  for (const k of ['namespace', 'host', 'source']) if (typeof r[k] !== 'string' || !r[k]) error(`rollout.${k} is missing`);
  if (r.host && !/^https:\/\//.test(r.host)) error(`rollout.host "${r.host}" must be the app's public https:// address`);
  if (r.source && !exists(r.source)) out.push({ level: 'warn', detail: `rollout.source ${r.source} doesn't exist yet; Image Updater writes it` });
  const p = r.prometheus;
  if (!p || !p.namespace || !p.service || !p.port) error('rollout.prometheus needs namespace, service and port');
  const services = Object.entries(r.services ?? {});
  if (services.length === 0) error('rollout.services must name at least one service');
  for (const [name, s] of services) {
    if (typeof s.smoke !== 'string' || !s.smoke.startsWith('/')) error(`rollout.services.${name}.smoke must be a path, e.g. "/"`);
    if (typeof s.metrics !== 'boolean') error(`rollout.services.${name}.metrics must be true or false`);
    if (!Array.isArray(s.inputs) || s.inputs.length === 0) error(`rollout.services.${name}.inputs must list the paths its image is built from`);
  }
  return out;
}

function main(argv) {
  const { files, flags } = parseArgs(argv, ['--rollout']);
  const root = projectRoot();
  const path = resolve(files[0] ?? process.env.SDLC_CONFIG ?? join(root, '.sdlc/config.json'));
  const exists = (p) => existsSync(join(root, p));
  let results;
  try {
    results = checkConfig(JSON.parse(readFileSync(path, 'utf8')), { exists });
  } catch (e) {
    console.error(`${path}: ${e.message}`);
    return 1;
  }
  const rollout = flags.rollout ?? (existsSync(join(root, '.sdlc/rollout.json')) ? join(root, '.sdlc/rollout.json') : null);
  if (rollout) {
    try {
      results.push(...checkRollout(JSON.parse(readFileSync(rollout, 'utf8')), { exists }));
    } catch (e) {
      results.push({ level: 'error', detail: `${rollout}: ${e.message}` });
    }
  }
  for (const r of results) console.log(`${r.level === 'error' ? 'ERROR' : 'warn'} ${r.detail}`);
  const errors = results.filter((r) => r.level === 'error').length;
  const warnings = results.length - errors;
  console.log(errors || warnings ? `${errors} errors, ${warnings} warnings` : `${path} is usable`);
  return errors || (flags.strict && warnings) ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv);
