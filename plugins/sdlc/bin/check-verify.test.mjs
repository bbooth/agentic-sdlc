import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argv, ranAndPassed, required, testExists, verificationChecks } from './check-verify.mjs';

const ran = (kind = 'test') => ({ kind, ref: 'services/identity/internal/service/tenants_test.go:TestUpdateIgnoresRemovedFields', observed: 'ok' });
const met = (id, evidence = [ran()]) => ({ id, verdict: 'met', evidence });
const failed = (over = {}, criteria = ['AC-1', 'AC-2']) => verificationChecks({
  criteria, head: 'c77306c', files: ['docs/STATUS.md'],
  verification: { commit: 'c77306c', criteria: [met('AC-1'), met('AC-2')], ...over },
}).filter((x) => !x.pass).map((x) => x.name);

test('every criterion met with a test that ran passes', () => {
  assert.deepEqual(failed(), []);
});

test('the verifier must have judged the commit being gated', () => {
  assert.deepEqual(failed({ commit: '70802fd' }), ['verified_commit']);
  assert.deepEqual(failed({ commit: 'c77306c1f00d' }), []);
});

test('a criterion with no verdict, or an unmet one, fails', () => {
  assert.deepEqual(failed({ criteria: [met('AC-1')] }), ['criteria_covered', 'criteria_met']);
  assert.deepEqual(failed({ criteria: [met('AC-1'), { ...met('AC-2'), verdict: 'unverified' }] }), ['criteria_met']);
  assert.deepEqual(failed({}, []), ['criteria_covered']);
});

test('reading the code is not evidence on its own', () => {
  assert.deepEqual(failed({ criteria: [met('AC-1'), met('AC-2', [ran('inspection')])] }), ['evidence']);
  assert.deepEqual(failed({ criteria: [met('AC-1'), met('AC-2', [{ kind: 'test', ref: 'x' }])] }), ['evidence']);
});

test('an API change needs a check against a running service, a UI change a browser', () => {
  assert.deepEqual(required(['proto/booking/identity/v1/tenant.proto', 'services/identity/internal/service/tenants_test.go']), ['e2e']);
  assert.deepEqual(required(['web/src/views/Home.vue', 'web/src/api/schema.d.ts']), ['browser']);
  assert.deepEqual(required(['web/src/api/types.ts', 'docs/STATUS.md']), []);
  const api = { criteria: ['AC-1'], head: 'c77306c', files: ['services/identity/internal/service/tenants.go'] };
  const names = (v) => verificationChecks({ ...api, verification: v }).filter((x) => !x.pass).map((x) => x.name);
  assert.deepEqual(names({ commit: 'c77306c', criteria: [met('AC-1')] }), ['end_to_end']);
  assert.deepEqual(names({ commit: 'c77306c', criteria: [met('AC-1', [ran(), ran('e2e')])] }), []);
});

test('a named test must be in the repo', () => {
  const read = (f) => (f === 'a_test.go' ? 'func TestA(t *testing.T) {}' : null);
  assert.equal(testExists('a_test.go:TestA', read), null);
  assert.match(testExists('a_test.go:TestB', read), /no "TestB"/);
  assert.match(testExists('b_test.go:TestA', read), /does not exist/);
  assert.match(testExists('a_test.go', read), /ref is/);
});

test('a re-run must pass without skipping', () => {
  assert.equal(ranAndPassed('go test -run X ./...', 0, '--- PASS: TestX (0.01s)\nok'), null);
  assert.match(ranAndPassed('go test -run X ./...', 0, '--- SKIP: TestX (0.00s)\n--- PASS: TestY\nok'), /skipped/);
  assert.match(ranAndPassed('go test -run X ./...', 0, 'ok  pkg 0.1s [no tests to run]'), /no tests/);
  assert.match(ranAndPassed('go test -run X ./...', 1, '--- FAIL: TestX'), /failed/);
  assert.equal(ranAndPassed('npm test -- tenants', 0, '1 passed'), null);
});

test('a command is split on quotes, never handed to a shell', () => {
  assert.deepEqual(argv("go test -run '^TestA$|^TestB$' ./internal/store/"), ['go', 'test', '-run', '^TestA$|^TestB$', './internal/store/']);
  assert.deepEqual(argv('npm test -- "tenant form"'), ['npm', 'test', '--', 'tenant form']);
});
