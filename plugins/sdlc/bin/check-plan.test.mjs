import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkPlan, gateRecord } from './check-plan.mjs';
import { approvalRecord } from './approve.mjs';
import { comment } from './lib.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const spec = read('../templates/spec.example.md');
const good = read('../templates/plan.example.md');
const failed = (plan, s = spec) => checkPlan(s, plan).filter((c) => !c.pass).map((c) => c.name);

test('the example plan passes', () => {
  assert.deepEqual(failed(good), []);
});

test('the unfilled template fails', () => {
  assert.ok(failed(read('../templates/plan.md')).includes('no_placeholders'));
});

test('every criterion needs a task', () => {
  assert.deepEqual(failed(good.replace('- **Covers:** AC-1, AC-2', '- **Covers:** AC-2')), ['criteria_covered']);
});

test('a task cannot cover a criterion the spec lacks', () => {
  assert.deepEqual(failed(good.replace('- **Covers:** AC-1, AC-2', '- **Covers:** AC-1, AC-9')), ['criteria_covered']);
});

test('a large task must be split', () => {
  assert.deepEqual(failed(good.replace('- **Size:** M', '- **Size:** L')), ['tasks_pr_sized']);
});

test('a task cannot wait on a later one', () => {
  assert.deepEqual(failed(good.replace('- **Depends on:** none', '- **Depends on:** T-2')), ['tasks_ordered']);
});

test('a task needs its tests', () => {
  assert.deepEqual(failed(good.replace(/^- \*\*Tests:\*\* a store test.*$/m, '')), ['tasks_complete']);
});

test('a plan for an older spec fails', () => {
  assert.deepEqual(failed(good, spec.replace('- **Spec version:** 1', '- **Spec version:** 2')), ['spec_version']);
});

test('a plan read back from Linear passes', () => {
  assert.deepEqual(failed(good.replace(/^- /gm, '* '), spec.replace(/^- /gm, '* ')), []);
});

test('the record names both versions', () => {
  const r = gateRecord(spec, good, { ticket: 'TRU-0' });
  assert.equal(r.result, 'pass');
  assert.deepEqual(r.inputs, { spec_version: '1', plan_version: '1' });
  assert.match(comment(r), /^### Gate: Plan \(pass\) · round 1\n- Inputs: spec version 1, plan version 1/);
});

test('an approval quotes the owner', () => {
  const r = approvalRecord({ stage: 'spec', said: 'I approve', ticket: 'TRU-0' });
  assert.equal(r.result, 'pass');
  assert.equal(r.decision, 'Advance to Plan');
  assert.equal(r.checks[0].detail, 'The owner said: "I approve"');
  assert.match(comment(r), /^### Gate: Spec approval \(pass\)/);
});

test('a rejection sends the spec back', () => {
  const r = approvalRecord({ stage: 'spec', said: 'Too broad', reject: true, ticket: 'TRU-0' });
  assert.equal(r.result, 'fail');
  assert.equal(r.decision, 'Back to Spec: revise');
});
