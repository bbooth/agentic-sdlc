#!/usr/bin/env node
// The Spec gate's deterministic checks. Reads a spec in the shape of
// templates/spec.md and prints a gate record (see
// schema/gate-record.schema.json). Exits 1 when the gate fails.
//
//   node bin/check-spec.mjs spec.md [--ticket ABC-12] [--round 2] [--comment]

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PLACEHOLDER, bullets, emit, field, numbered, parseArgs, record, requireConfig, sections, subsections } from './lib.mjs';

export { comment } from './lib.mjs';

const TYPES = ['feature', 'bug', 'chore'];
// Criteria allowed per size, so a small bug doesn't grow sixteen of them.
const CRITERIA_LIMITS = { S: [1, 3], M: [2, 6], L: [3, 10] };
const SECTIONS = ['Problem', 'Acceptance criteria', 'Non-goals', 'Success metrics'];

export function checkSpec(text) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  const type = field(text, 'Type');
  const size = field(text, 'Size');
  add('type', TYPES.includes(type), TYPES.includes(type) ? type : `Type must be one of ${TYPES.join(', ')}`);
  add('size', size in CRITERIA_LIMITS, size in CRITERIA_LIMITS ? size : 'Size must be S, M or L');

  const secs = sections(text);
  const missing = SECTIONS.filter((s) => !(secs[s] ?? '').trim());
  add('sections', missing.length === 0, missing.length ? `Missing or empty: ${missing.join(', ')}` : `${SECTIONS.length} of ${SECTIONS.length} present`);

  const acs = subsections(secs['Acceptance criteria'] ?? '');
  const { ok, bad } = numbered(acs, 'AC');
  add('criteria_numbered', ok,
    acs.length === 0 ? 'No "### AC-n: title" headings' : bad.length ? `Not numbered AC-1, AC-2, ... in order: ${bad.join('; ')}` : `${acs.length} criteria`);

  // Each of Given, When and Then must start a line and say something.
  const incomplete = acs
    .filter((c) => !['Given', 'When', 'Then'].every((k) => new RegExp(`^([-*] )?\\*\\*${k}\\*\\* +\\S`, 'm').test(c.body)))
    .map((c) => c.heading.split(':')[0]);
  add('criteria_testable', acs.length > 0 && incomplete.length === 0,
    incomplete.length ? `Missing Given, When or Then: ${incomplete.join(', ')}` : 'Every criterion has Given, When and Then');

  if (size in CRITERIA_LIMITS) {
    const [min, max] = CRITERIA_LIMITS[size];
    add('criteria_count', acs.length >= min && acs.length <= max, `${acs.length} criteria; size ${size} allows ${min} to ${max}`);
  }

  // A metric names where it's read from, so the rollout watcher can check it.
  const metrics = bullets(secs['Success metrics'] ?? '');
  const unsourced = metrics.filter((m) => !/\(signal: *[^)]+\)/i.test(m));
  add('success_metrics', metrics.length > 0 && unsourced.length === 0,
    metrics.length === 0 ? 'No success metrics' : unsourced.length ? `${unsourced.length} without "(signal: ...)"` : `${metrics.length} with a signal`);

  const placeholders = text.split('\n').filter((l) => PLACEHOLDER.test(l)).length;
  add('no_placeholders', placeholders === 0, placeholders ? `${placeholders} lines with TBD, TODO or <...>` : 'None');

  return checks;
}

export function gateRecord(text, opts = {}) {
  return record({
    ...opts,
    stage: 'spec',
    inputs: { spec_version: field(text, 'Spec version') || '1' },
    agent: { name: 'check-spec', kind: 'deterministic' },
    checks: checkSpec(text),
    pass: 'Ready for approval: the owner approves the spec',
    fail: 'Back to Spec: revise and re-run',
  });
}

function main(argv) {
  requireConfig();
  const { files, flags } = parseArgs(argv, ['--ticket', '--round']);
  if (files.length !== 1) {
    console.error('usage: check-spec.mjs <spec.md> [--ticket ID] [--round N] [--comment]');
    return 2;
  }
  return emit(gateRecord(readFileSync(files[0], 'utf8'), { ticket: flags.ticket ?? null, round: Number(flags.round ?? 1) }), flags);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv);
