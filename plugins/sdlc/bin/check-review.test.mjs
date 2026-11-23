import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten, requiredScopes, reviewChecks } from './check-review.mjs';

const scopes = (files) => requiredScopes(files).map((s) => s.name);
const finding = (over = {}) => ({ severity: 'minor', status: 'open', summary: 'services/identity/internal/service/tenants.go:119: update_time is no longer bumped', ...over });
const required = requiredScopes(['services/identity/internal/store/tenant_store.go']);
const reviewed = (findings = {}) => required.map((s) => ({ scope: s.name, findings: findings[s.name] ?? [] }));
const failed = (reviews, over = {}) => reviewChecks({ required, head: '3b0baf3', review: { commit: '3b0baf3', reviews, ...over } }).filter((x) => !x.pass).map((x) => x.name);

test('the diff picks its reviewers', () => {
  assert.deepEqual(scopes(['docs/STATUS.md', 'gen/go/x.pb.go', '.sdlc/records/TRU-6/build-1.json', 'README.md']), []);
  assert.deepEqual(scopes(['proto/booking/identity/v1/tenant.proto']), ['security', 'api']);
  assert.deepEqual(scopes(['services/identity/internal/store/tenant_store.go']), ['security', 'data', 'operability']);
  assert.deepEqual(scopes(['services/identity/internal/service/tenants.go']), ['security', 'api', 'operability']);
  assert.deepEqual(scopes(['services/identity/internal/db/migrations/000008_x.up.sql']), ['security', 'data', 'operability']);
  assert.deepEqual(scopes(['web/src/views/Home.vue']), ['security', 'web']);
  assert.deepEqual(scopes(['web/server/main.go', 'deploy/values.yaml']), ['security', 'operability']);
});

test('clean reviews of every scope pass, and minor findings go along', () => {
  assert.deepEqual(failed(reviewed()), []);
  assert.deepEqual(failed(reviewed({ data: [finding()] })), []);
});

test('a scope nobody reviewed fails', () => {
  assert.deepEqual(failed(reviewed().slice(1)), ['scopes_covered']);
  assert.deepEqual(failed([...reviewed().slice(1), { scope: 'security' }]), ['scopes_covered']);
});

test('the reviewers must have read the commit being gated', () => {
  assert.deepEqual(failed(reviewed(), { commit: 'c77306c' }), ['reviewed_commit']);
});

test('a finding names a file and line', () => {
  assert.deepEqual(failed(reviewed({ data: [finding({ summary: 'The tests feel thin' })] })), ['findings_located']);
  assert.deepEqual(failed(reviewed({ data: [finding({ severity: 'nit' })] })), ['findings_located']);
});

test('a blocking finding stands unless the judge refutes it with a reason', () => {
  const blocking = (over) => reviewed({ security: [finding({ severity: 'blocking', ...over })] });
  assert.deepEqual(failed(blocking({})), ['blocking_judged', 'no_blocking_findings']);
  assert.deepEqual(failed(blocking({ judged: 'confirmed' })), ['no_blocking_findings']);
  assert.deepEqual(failed(blocking({ judged: 'refuted' })), ['blocking_judged', 'no_blocking_findings']);
  assert.deepEqual(failed(blocking({ judged: 'refuted', reason: 'The handler checks membership at tenants.go:88' })), []);
  // The author marking it dismissed changes nothing.
  assert.deepEqual(failed(blocking({ status: 'dismissed', reason: 'not a problem' })), ['blocking_judged', 'no_blocking_findings']);
});

test('the record carries each finding with its scope and the judge\'s call', () => {
  const [f] = flatten([{ scope: 'api', findings: [finding({ severity: 'blocking', judged: 'refuted', reason: 'r' })] }]);
  assert.deepEqual(f, { severity: 'blocking', summary: finding().summary, status: 'dismissed', scope: 'api', reason: 'r', judged: 'refuted' });
});
