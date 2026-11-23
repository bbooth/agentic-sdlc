import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aborted, analysisCheck, digests, podsCheck, rebuilt, rolloutCheck, servedCheck, settled, smokeCheck, unfinished, waiting } from './check-rollout.mjs';

// Shapes copied from TRU-6's rollout of identity on 2026-11-22.
const OLD = 'sha256:08a5abf63eeeb3f1e362924e887e78a53b33a6e32a1c53dcccc8b08122da5349';
const NEW = 'sha256:9cb3a06caf4c250449b539cbbba883b1d5abee630878049aa13ed14d896c806b';
const source = (identity) => `helm:
  parameters:
  - name: identity.image.repository
    value: ghcr.io/bbooth/booking-identity
    forcestring: true
  - name: identity.image.tag
    value: latest@${identity}
    forcestring: true
  - name: web.image.tag
    value: latest@sha256:f3dfb912ddaeba369625fc1c9b9785b86aead99567fc042b480fe72210f7c1e3
    forcestring: true
`;
const rollout = (status = {}, image = NEW) => ({
  spec: {
    template: { spec: { containers: [{ image: `ghcr.io/bbooth/booking-identity:latest@${image}` }] } },
    strategy: { canary: { steps: [{ setWeight: 20 }, { analysis: {} }, { setWeight: 50 }, { analysis: {} }, { setWeight: 100 }] } },
  },
  status: { phase: 'Healthy', stableRS: '6d4ddc4449', currentPodHash: '6d4ddc4449', currentStepIndex: 5, replicas: 2, updatedReplicas: 2, readyReplicas: 2, ...status },
});
const analysisRun = (step, phase = 'Successful', hash = '6d4ddc4449') => ({
  metadata: { name: `identity-${hash}-21-${step}`, labels: { 'rollouts-pod-template-hash': hash, 'step-index': String(step) }, ownerReferences: [{ kind: 'Rollout', name: 'identity' }] },
  status: { phase, metricResults: [{ name: 'error-rate', phase, measurements: [{ phase, value: '[0]' }, { phase, value: '[0]' }] }] },
});
const pod = (over = {}) => ({
  metadata: { labels: { 'app.kubernetes.io/name': 'identity', 'rollouts-pod-template-hash': '6d4ddc4449' } },
  status: { containerStatuses: [{ ready: true, restartCount: 0, imageID: `ghcr.io/bbooth/booking-identity@${NEW}`, ...over }] },
});

const services = {
  identity: { inputs: ['services/identity/', 'gen/go/', 'pkg/', 'go.work'] },
  scheduling: { inputs: ['services/scheduling/', 'gen/go/', 'pkg/', 'go.work'] },
  web: { inputs: ['web/'] },
};

test('a merge rebuilds the images whose inputs it touched', () => {
  assert.deepEqual(rebuilt(['services/identity/internal/store/tenant_store.go'], services), ['identity']);
  assert.deepEqual(rebuilt(['gen/go/booking/identity/v1/tenant.pb.go', 'web/src/api/types.ts'], services), ['identity', 'scheduling', 'web']);
  assert.deepEqual(rebuilt(['docs/STATUS.md', '.sdlc/README.md', 'go.workspace'], services), []);
});

test('a rebuilt image is out once its digest differs from the one at the merge', () => {
  assert.deepEqual(digests(source(NEW)), { identity: NEW, web: 'sha256:f3dfb912ddaeba369625fc1c9b9785b86aead99567fc042b480fe72210f7c1e3' });
  // Image Updater had committed identity but not yet web.
  assert.deepEqual(waiting(['identity', 'web'], digests(source(OLD)), digests(source(NEW))), ['web']);
  assert.deepEqual(waiting(['identity'], digests(source(OLD)), digests(source(NEW))), []);
});

test('a Rollout settled on the new digest passes', () => {
  assert.equal(rolloutCheck('identity', rollout(), NEW).pass, true);
});

test('Healthy is not settled while old pods scale down', () => {
  // The first Healthy poll: replicas 4, updatedReplicas 2.
  const scaling = rollout({ replicas: 4, readyReplicas: 4 });
  assert.equal(settled(scaling), false);
  assert.equal(unfinished(scaling, NEW), true);
  assert.equal(unfinished(rollout(), NEW), false);
  assert.match(rolloutCheck('identity', scaling, NEW).detail, /still scaling down/);
});

test('a Rollout still on the old image, in progress, or aborted fails', () => {
  assert.match(rolloutCheck('identity', rollout({}, OLD), NEW).detail, /isn't on/);
  assert.match(rolloutCheck('identity', rollout({ phase: 'Progressing', currentStepIndex: 1, message: 'more replicas need to be updated', stableRS: 'd56c8bcf8' }), NEW).detail, /Progressing at step 1/);
  const gone = rollout({ phase: 'Degraded', abort: true, message: 'RolloutAborted: metric "error-rate" assessed Failed', stableRS: 'd56c8bcf8' });
  assert.equal(aborted(gone), true);
  assert.equal(unfinished(gone, NEW), false);
  assert.match(rolloutCheck('identity', gone, NEW).detail, /^Aborted .*error-rate.*stable version is still serving/);
});

test('every analysis step needs a Successful run for this hash', () => {
  const ok = analysisCheck('identity', rollout(), [analysisRun(1), analysisRun(3), analysisRun(1, 'Failed', 'd56c8bcf8')]);
  assert.equal(ok.check.pass, true);
  assert.equal(ok.evidence[0], 'identity identity-6d4ddc4449-21-1 error-rate: Successful, measured [0] [0]');
  assert.match(analysisCheck('identity', rollout(), [analysisRun(1)]).check.detail, /1 of 2 analysis runs/);
  assert.match(analysisCheck('identity', rollout(), [analysisRun(1), analysisRun(3, 'Failed')]).check.detail, /21-3 is Failed/);
});

test('the new pods are ready, on the digest, and have not restarted', () => {
  assert.equal(podsCheck('identity', [pod(), pod()], '6d4ddc4449', NEW).pass, true);
  assert.match(podsCheck('identity', [pod({ restartCount: 2 })], '6d4ddc4449', NEW).detail, /2 restarts/);
  assert.match(podsCheck('identity', [pod({ imageID: `x@${OLD}` })], '6d4ddc4449', NEW).detail, /No container runs/);
  assert.match(podsCheck('identity', [pod()], 'd56c8bcf8', NEW).detail, /No pods/);
});

test('new pods that served nothing, or faulted, fail', () => {
  assert.match(servedCheck('identity', '6d4ddc4449', {}).detail, /counted no requests/);
  assert.equal(servedCheck('identity', '6d4ddc4449', { Unauthenticated: 5 }).detail, '5 requests to 6d4ddc4449 (5 Unauthenticated), 0 server faults');
  assert.equal(servedCheck('identity', '6d4ddc4449', { OK: 397, Internal: 3 }).pass, true);
  assert.match(servedCheck('identity', '6d4ddc4449', { Unauthenticated: 4, Unavailable: 1 }).detail, /1 of 5 requests/);
  // Requests counted before this run don't show that this run's arrived.
  assert.match(servedCheck('identity', '6d4ddc4449', { Unauthenticated: 5 }, { before: 5, sent: 5 }).detail, /counted 0 of the 5 smoke requests/);
  assert.equal(servedCheck('identity', '6d4ddc4449', { Unauthenticated: 10 }, { before: 5, sent: 5 }).detail, '10 requests to 6d4ddc4449 (10 Unauthenticated), 5 since the smoke requests, 0 server faults');
});

test('a smoke request may be refused, but not fail on the server', () => {
  assert.equal(smokeCheck('identity', '/v1/tenants', [401, 401, 401]).pass, true);
  assert.equal(smokeCheck('identity', '/v1/tenants', [401, 502]).pass, false);
  assert.equal(smokeCheck('identity', '/v1/tenants', [0]).pass, false);
});
