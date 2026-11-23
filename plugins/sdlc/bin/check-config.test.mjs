import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkConfig, checkRollout } from './check-config.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const errors = (c, opts) => checkConfig(c, opts).filter((r) => r.level === 'error').map((r) => r.detail);
const booking = read('../examples/booking/config.json');

test('the example configs have no errors', () => {
  assert.deepEqual(errors(booking), []);
  assert.deepEqual(errors(read('../examples/rust/config.json')), []);
  assert.deepEqual(checkRollout(read('../examples/booking/rollout.json')).filter((r) => r.level === 'error'), []);
});

test('a bad pattern, a missing key and an unknown agent are errors', () => {
  const bad = structuredClone(booking);
  bad.ships.push('(');
  delete bad.tracker.key;
  bad.reviewScopes[1].agent = 'review-everything';
  const found = errors(bad).join('\n');
  assert.match(found, /ships: "\(" is not a regular expression/);
  assert.match(found, /tracker\.key is missing/);
  assert.match(found, /review-everything/);
});

test('SQL without store tests would fail every SQL change', () => {
  const bad = { ...structuredClone(booking), storeTests: [] };
  assert.match(errors(bad).join('\n'), /storeCode is set without storeTests/);
});

test('a path that is not there yet is only a warning', () => {
  const r = checkConfig(booking, { exists: () => false });
  assert.ok(r.some((x) => x.level === 'warn' && /services\/identity/.test(x.detail)));
  assert.equal(r.filter((x) => x.level === 'error').length, 0);
});

test('a rollout needs an https host and each service its inputs', () => {
  const r = { ...read('../examples/booking/rollout.json'), host: 'booking.example.com' };
  delete r.services.web.inputs;
  const found = checkRollout(r).map((x) => x.detail).join('\n');
  assert.match(found, /https/);
  assert.match(found, /web\.inputs/);
});
