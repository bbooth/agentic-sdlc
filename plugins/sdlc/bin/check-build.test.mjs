import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areas, diffChecks, findingsCheck } from './check-build.mjs';
import { checksFor, refusal } from './on-edit.mjs';

const c = (file, lines = 10, added = false) => ({ file, lines, added });
const good = [
  c('services/identity/internal/store/tenant_store.go', 40),
  c('services/identity/internal/store/tenant_store_test.go', 30),
  c('docs/STATUS.md', 2),
];
const failed = (changes, extra = {}) => diffChecks({ branch: 'backend/tru-6', changes, size: 'M', ...extra }).filter((x) => !x.pass).map((x) => x.name);

test('a tested, documented change passes', () => {
  assert.deepEqual(failed(good), []);
});

test('a branch needs a prefix', () => {
  assert.deepEqual(failed(good, { branch: 'tru-6' }), ['branch']);
});

test('code without a test fails', () => {
  assert.deepEqual(failed([c('web/src/views/Home.vue'), c('docs/STATUS.md')]), ['tests_changed']);
});

test('SQL needs a store test, not just any test', () => {
  const changes = [c('services/identity/internal/store/tenant_store.go'), c('services/identity/internal/service/tenants_test.go'), c('docs/STATUS.md')];
  assert.deepEqual(failed(changes), ['sql_has_store_test']);
});

test('a new up migration needs its down', () => {
  const up = c('services/identity/internal/db/migrations/000008_x.up.sql', 3, true);
  assert.deepEqual(failed([...good, up]), ['migrations_paired']);
  assert.deepEqual(failed([...good, up, c('services/identity/internal/db/migrations/000008_x.down.sql', 3, true)]), []);
});

test('a proto change needs regenerated code', () => {
  assert.deepEqual(failed([...good, c('proto/booking/identity/v1/tenant.proto')]), ['generated_with_proto']);
});

test('generated files do not count toward size', () => {
  assert.deepEqual(failed([...good, c('gen/go/x.pb.go', 5000), c('proto/a.proto', 5)]), []);
  assert.deepEqual(failed([...good, c('services/identity/internal/service/tenants.go', 900)]), ['size']);
});

test('tests count at half toward size', () => {
  const code = 'services/identity/internal/service/tenants.go';
  const tests = 'services/identity/internal/service/tenants_test.go';
  assert.deepEqual(failed([c(code, 499), c(tests, 600), c('docs/STATUS.md', 1)]), []);
  assert.deepEqual(failed([c(code, 499), c(tests, 602), c('docs/STATUS.md', 1)]), ['size']);
});

test('lockfiles do not count toward size', () => {
  assert.deepEqual(failed([...good, c('Cargo.lock', 3000), c('web/package-lock.json', 3000), c('services/identity/go.sum', 900)]), []);
  assert.deepEqual(failed([...good, c('docs/Cargo.lock.md', 900)]), ['size']);
});

test('the status file is part of the work', () => {
  assert.deepEqual(failed(good.slice(0, 2)), ['status_updated']);
});

test('an open blocking finding fails the gate', () => {
  assert.equal(findingsCheck([{ severity: 'blocking', status: 'open', summary: 'x' }]).pass, false);
  assert.equal(findingsCheck([{ severity: 'blocking', status: 'fixed', summary: 'x' }, { severity: 'minor', status: 'open', summary: 'y' }]).pass, true);
});

test('gen/go rebuilds every service; no Docker means short tests', () => {
  const a = areas(['gen/go/x.pb.go'], { docker: false });
  assert.deepEqual(a.map((x) => x.name), ['pkg', 'services/identity', 'services/scheduling']);
  assert.ok(a.every((x) => x.short && x.commands.includes('go test -short ./...')));
  assert.deepEqual(areas(['web/server/main.go'])[0].env, { GOWORK: 'off' });
});

test('the edit hook refuses generated files and rewritten records', () => {
  assert.match(refusal('gen/go/x.pb.go', true), /generated/);
  assert.match(refusal('.sdlc/records/TRU-6/build-1.json', true), /append-only/);
  assert.equal(refusal('.sdlc/records/TRU-6/build-2.json', false), null);
  assert.equal(refusal('services/identity/internal/store/tenant_store.go', true), null);
});

test('the edit hook picks checks by file type', () => {
  assert.deepEqual(checksFor('proto/a.proto', '/r').map((x) => x.name), ['buf lint']);
  assert.deepEqual(checksFor('a/db/migrations/000008_x.up.sql', '/r'), [{ name: 'down migration', missing: 'a/db/migrations/000008_x.down.sql' }]);
  assert.deepEqual(checksFor('README.md', '/r'), []);
});
