#!/usr/bin/env node
// The Plan gate's deterministic checks. Reads a ticket's spec and a plan in
// the shape of templates/plan.md, and prints a gate record. Exits 1
// when the gate fails.
//
//   node bin/check-plan.mjs spec.md plan.md [--ticket ABC-12] [--round 2] [--comment]

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PLACEHOLDER, bullets, emit, field, numbered, parseArgs, record, requireConfig, sections, subsections } from './lib.mjs';

const SECTIONS = ['Design', 'Tasks', 'Risks'];
// A task is one PR. An L is too big to review in one, so it's split.
const SIZES = ['S', 'M'];
const MAX_TASKS = 8;
const TASK_FIELDS = ['Covers', 'Size', 'Depends on', 'Changes', 'Tests'];

const ids = (value, prefix) => value.match(new RegExp(`${prefix}-\\d+`, 'g')) ?? [];
const id = (item) => item.heading.split(':')[0];

export function checkPlan(spec, plan) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  const specVersion = field(spec, 'Spec version') || '1';
  const planned = field(plan, 'Spec version');
  add('spec_version', planned === specVersion, planned === specVersion ? `Plans spec v${specVersion}` : `Plan is for spec v${planned || '?'}; the spec is v${specVersion}`);

  const secs = sections(plan);
  const missing = SECTIONS.filter((s) => !(secs[s] ?? '').trim());
  add('sections', missing.length === 0, missing.length ? `Missing or empty: ${missing.join(', ')}` : `${SECTIONS.length} of ${SECTIONS.length} present`);

  const tasks = subsections(secs.Tasks ?? '');
  const { ok, bad } = numbered(tasks, 'T');
  add('tasks_numbered', ok,
    tasks.length === 0 ? 'No "### T-n: title" headings' : bad.length ? `Not numbered T-1, T-2, ... in order: ${bad.join('; ')}` : `${tasks.length} tasks`);
  add('task_count', tasks.length <= MAX_TASKS, `${tasks.length} tasks; at most ${MAX_TASKS}`);

  const unfilled = tasks.filter((t) => TASK_FIELDS.some((f) => !field(t.body, f))).map(id);
  add('tasks_complete', tasks.length > 0 && unfilled.length === 0,
    unfilled.length ? `Missing one of ${TASK_FIELDS.join(', ')}: ${unfilled.join(', ')}` : `Every task has ${TASK_FIELDS.join(', ')}`);

  const oversized = tasks.filter((t) => !SIZES.includes(field(t.body, 'Size'))).map(id);
  add('tasks_pr_sized', tasks.length > 0 && oversized.length === 0,
    oversized.length ? `Size must be S or M; split: ${oversized.join(', ')}` : 'Every task is S or M');

  // A task may only wait on an earlier one, which also rules out cycles.
  const outOfOrder = tasks
    .filter((t, i) => ids(field(t.body, 'Depends on'), 'T').some((d) => Number(d.slice(2)) > i))
    .map(id);
  add('tasks_ordered', outOfOrder.length === 0,
    outOfOrder.length ? `Depends on itself or a later task: ${outOfOrder.join(', ')}` : 'Every dependency is an earlier task');

  const acs = subsections(sections(spec)['Acceptance criteria'] ?? '').map(id);
  const covered = new Set(tasks.flatMap((t) => ids(field(t.body, 'Covers'), 'AC')));
  const uncovered = acs.filter((a) => !covered.has(a));
  const unknown = [...covered].filter((a) => !acs.includes(a));
  add('criteria_covered', acs.length > 0 && uncovered.length === 0 && unknown.length === 0,
    uncovered.length ? `No task covers: ${uncovered.join(', ')}` : unknown.length ? `Not in the spec: ${unknown.join(', ')}` : `${acs.length} of ${acs.length} criteria have a task`);

  const risks = bullets(secs.Risks ?? '');
  add('risks', risks.length > 0, risks.length ? `${risks.length} listed` : 'List at least one, or say why there is none');

  const placeholders = plan.split('\n').filter((l) => PLACEHOLDER.test(l)).length;
  add('no_placeholders', placeholders === 0, placeholders ? `${placeholders} lines with TBD, TODO or <...>` : 'None');

  return checks;
}

export function gateRecord(spec, plan, opts = {}) {
  return record({
    ...opts,
    stage: 'plan',
    inputs: { spec_version: field(spec, 'Spec version') || '1', plan_version: field(plan, 'Plan version') || '1' },
    agent: { name: 'check-plan', kind: 'deterministic' },
    checks: checkPlan(spec, plan),
    pass: 'Advance to Build: one sub-ticket per task',
    fail: 'Back to Plan: revise and re-run',
  });
}

function main(argv) {
  requireConfig();
  const { files, flags } = parseArgs(argv, ['--ticket', '--round']);
  if (files.length !== 2) {
    console.error('usage: check-plan.mjs <spec.md> <plan.md> [--ticket ID] [--round N] [--comment]');
    return 2;
  }
  const [spec, plan] = files.map((f) => readFileSync(f, 'utf8'));
  return emit(gateRecord(spec, plan, { ticket: flags.ticket ?? null, round: Number(flags.round ?? 1) }), flags);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv);
