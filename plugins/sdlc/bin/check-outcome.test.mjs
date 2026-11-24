import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dueAt, metrics, outcomeChecks } from './check-outcome.mjs';

// TRU-5's success metrics, as its spec has them (Linear's "*" bullets).
const spec = `## Problem

x

## Success metrics

* Zero identity requests fail on a missing column in the 24 hours after each of the two releases (signal: identity pod logs matching \`column "(display_name|coach_mode)" does not exist\`)
* The migrate Job for the second release completes on its first run (signal: the \`identity-migrate\` Job's status in ArgoCD)
`;

const failed = ({ checks }) => checks.filter((c) => !c.pass).map((c) => c.name);
const ev = [{ command: 'kubectl logs -n booking -l app=identity --since=24h', observed: '0 matching lines in 212' }];
const tasks = [
  { id: 'TRU-6', rollout: 'pass', live_at: '2026-11-22T23:23:28Z' },
  { id: 'TRU-7', rollout: 'pass', live_at: '2026-11-23T03:17:15Z' },
];
const good = (over = {}) => ({
  tasks,
  metrics: [
    { id: 'M-1', verdict: 'met', measured_to: '2026-11-24T03:20:00Z', evidence: ev },
    { id: 'M-2', verdict: 'met', evidence: [{ command: 'kubectl get job identity-migrate -n booking -o json', observed: 'succeeded 1, failed 0' }] },
  ],
  ...over,
});

test('reads each success metric, its signal and the window it names', () => {
  const m = metrics(spec);
  assert.deepEqual(m.map((x) => x.id), ['M-1', 'M-2']);
  assert.equal(m[0].windowMs, 24 * 3_600_000);
  assert.match(m[0].signal, /^identity pod logs matching/);
  assert.doesNotMatch(m[0].text, /signal/);
  assert.equal(m[1].windowMs, 0);
});

test('a window named only inside the signal is not a wait', () => {
  assert.equal(metrics('## Success metrics\n\n- No 5xx (signal: `rate(x[5 minutes])`)\n')[0].windowMs, 0);
});

test('a signal keeps the brackets inside it', () => {
  const [m] = metrics('## Success metrics\n\n* Zero requests fail in the 24 hours after each release (signal: pod logs matching `column "(a|b)" does not exist`)\n');
  assert.equal(m.text, 'Zero requests fail in the 24 hours after each release');
  assert.equal(m.signal, 'pod logs matching `column "(a|b)" does not exist`');
  assert.equal(m.windowMs, 24 * 3600_000);
});

test('the gate is due after the longest window, counted from the last release', () => {
  assert.equal(dueAt(spec, '2026-11-23T03:17:15Z').toISOString(), '2026-11-24T03:17:15.000Z');
  assert.equal(dueAt('## Success metrics\n\n- Works (signal: logs)\n', '2026-11-23T03:17:15Z').toISOString(), '2026-11-23T03:17:15.000Z');
});

test('passes when every metric is met, with evidence, after its window', () => {
  const r = outcomeChecks({ spec, outcome: good() });
  assert.deepEqual(failed(r), []);
  assert.equal(r.early, false);
});

test('measured before the window has passed is early, not a fail', () => {
  const o = good();
  o.metrics[0].measured_to = '2026-11-23T09:17:15Z';
  const r = outcomeChecks({ spec, outcome: o });
  assert.deepEqual(failed(r), ['window_passed']);
  assert.equal(r.early, true);
  assert.match(r.checks.find((c) => c.name === 'window_passed').detail, /M-1 needs 24h .* 18h short/);
});

test('a windowed metric with no end time counts as not yet measured', () => {
  const o = good();
  delete o.metrics[0].measured_to;
  assert.deepEqual(failed(outcomeChecks({ spec, outcome: o })), ['window_passed']);
});

test('a metric that is not met, or that could not be measured, fails the gate', () => {
  for (const verdict of ['not_met', 'unknown']) {
    const o = good();
    o.metrics[1].verdict = verdict;
    const r = outcomeChecks({ spec, outcome: o });
    assert.deepEqual(failed(r), ['metrics_met']);
    assert.equal(r.early, false);
  }
});

test('an early run with a failed metric is a fail, not a wait', () => {
  const o = good();
  o.metrics[0].measured_to = '2026-11-23T09:17:15Z';
  o.metrics[1].verdict = 'not_met';
  assert.equal(outcomeChecks({ spec, outcome: o }).early, false);
});

test('every metric needs a verdict and every verdict needs something that ran', () => {
  const o = good();
  o.metrics.pop();
  assert.deepEqual(failed(outcomeChecks({ spec, outcome: o })), ['metrics_covered', 'metrics_met']);
  const p = good();
  p.metrics[1].evidence = [{ command: '', observed: 'looked fine' }];
  assert.deepEqual(failed(outcomeChecks({ spec, outcome: p })), ['evidence']);
});

test('every task must have passed the Rollout gate', () => {
  assert.deepEqual(failed(outcomeChecks({ spec, outcome: good({ tasks: [tasks[0], { id: 'TRU-7', rollout: 'fail', live_at: tasks[1].live_at }] }) })), ['tasks_live']);
  assert.deepEqual(failed(outcomeChecks({ spec, outcome: good({ tasks: [] }) })).includes('tasks_live'), true);
});

test('a measurement that changed the cluster or queried its database fails', () => {
  for (const command of ['kubectl exec -n booking identity-0 -- server migrate version', 'kubectl -n booking delete pod x', 'psql -c "select 1"']) {
    const o = good();
    o.metrics[1].evidence = [{ command, observed: '8' }];
    assert.deepEqual(failed(outcomeChecks({ spec, outcome: o })), ['read_only']);
  }
  const o = good();
  o.metrics[1].evidence = [{ command: 'kubectl get rollout identity -n booking -o json', observed: 'Healthy' }];
  assert.deepEqual(failed(outcomeChecks({ spec, outcome: o })), []);
});
