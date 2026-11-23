import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkSpec, comment, gateRecord } from './check-spec.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const good = read('../templates/spec.example.md');
const failed = (text) => checkSpec(text).filter((c) => !c.pass).map((c) => c.name);

test('the example spec passes', () => {
  assert.deepEqual(failed(good), []);
});

test('the unfilled template fails', () => {
  const names = failed(read('../templates/spec.md'));
  assert.ok(names.includes('no_placeholders'));
  assert.ok(names.includes('type'));
});

test('a criterion without Then fails', () => {
  assert.deepEqual(failed(good.replace(/^- \*\*Then\*\* .*$/m, '')), ['criteria_testable']);
});

test('criteria must be numbered in order', () => {
  assert.deepEqual(failed(good.replace('### AC-2:', '### AC-5:')), ['criteria_numbered']);
});

test('a small ticket is capped at three criteria', () => {
  const extra = [3, 4].map((n) => `### AC-${n}: More\n\n- **Given** a\n- **When** b\n- **Then** c\n`).join('\n');
  const text = good.replace('- **Size:** M', '- **Size:** S').replace('## Non-goals', `${extra}\n## Non-goals`);
  assert.deepEqual(failed(text), ['criteria_count']);
});

test('a metric needs a signal', () => {
  assert.deepEqual(failed(good.replace(/ \(signal: [^)]*\)/, '')), ['success_metrics']);
});

test('a comparison is not a placeholder', () => {
  assert.deepEqual(failed(good.replace('under 300 ms', '< 300 ms and > 0 ms')), []);
});

test('a spec read back from Linear passes', () => {
  assert.deepEqual(failed(good.replace(/^- /gm, '* ')), []);
});

test('the record matches the schema shape', () => {
  const schema = JSON.parse(read('../schema/gate-record.schema.json'));
  const record = gateRecord(good, { ticket: 'BOOK-1', round: 2, now: new Date('2026-11-21T00:00:00Z') });
  assert.deepEqual(Object.keys(record).sort(), [...schema.required].sort());
  assert.ok(schema.properties.stage.enum.includes(record.stage));
  assert.equal(record.result, 'pass');
  assert.equal(record.round, 2);
  assert.match(comment(record), /^### Gate: Spec \(pass\) · round 2/);
  assert.match(comment(record), /\n\+\+\+ Gate record\n[^]*\n\+\+\+$/);
});

test('a failing spec sends the ticket back', () => {
  const record = gateRecord(good.replace('- **Type:** feature', '- **Type:** epic'));
  assert.equal(record.result, 'fail');
  assert.match(record.decision, /^Back to Spec/);
});
