import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bodyChecks, recordChecks, sameChange, shipped, ticketsIn } from './check-pr.mjs';

const failed = (checks) => checks.filter((c) => !c.pass).map((c) => c.name);
const rec = (stage, over = {}) => ({ file: `.sdlc/records/TRU-6/${stage}-1.json`, fileRound: 1, stage, ticket: 'TRU-6', round: 1, result: 'pass', inputs: { commit: '3b0baf3' }, ...over });
const all = (over = {}) => ({ build: rec('build'), verify: rec('verify'), adversarial_review: rec('adversarial_review'), ...over });
const added = [['A', '.sdlc/records/TRU-6/build-1.json']];

const body = `## Summary

TRU-6: drops two fields.

## Test plan

- [x] AC-1 against the local stack
- [ ] Not verified: the canary

## Open findings

- [ ] **api** \`a.go:3\`: plain text errors
- [ ] **web** \`b.ts:9\`: stale fixture
`;

test('a PR is a ticket\'s when its diff adds that ticket\'s records', () => {
  assert.deepEqual(ticketsIn(['services/identity/a.go', '.sdlc/records/TRU-6/build-1.json', '.sdlc/records/TRU-6/verify-1.json']), ['TRU-6']);
  assert.deepEqual(ticketsIn(['.sdlc/bin/check-pr.mjs', 'docs/STATUS.md']), []);
  assert.deepEqual(ticketsIn(['.sdlc/records/TRU-6/build-1.json', '.sdlc/records/TRU-7/build-1.json']), ['TRU-6', 'TRU-7']);
});

test('only what ships needs a ticket', () => {
  assert.deepEqual(shipped(['.sdlc/bin/lib.mjs', '.github/workflows/ci.yaml', 'docs/STATUS.md', '.claude/skills/x/SKILL.md', 'CLAUDE.md']), []);
  assert.deepEqual(shipped(['docs/STATUS.md', 'deploy/values.yaml', 'web/src/App.vue']), ['deploy/values.yaml', 'web/src/App.vue']);
});

test('every stage before the PR has a passing record', () => {
  assert.deepEqual(failed(recordChecks({ ticket: 'TRU-6', records: all(), statuses: added })), []);
  assert.deepEqual(failed(recordChecks({ ticket: 'TRU-6', records: all({ verify: null }), statuses: added })), ['verify_passed']);
  assert.deepEqual(failed(recordChecks({ ticket: 'TRU-6', records: all({ adversarial_review: rec('adversarial_review', { result: 'fail' }) }), statuses: added })), ['adversarial_review_passed']);
});

test('a record copied from another ticket, stage or round doesn\'t count', () => {
  for (const over of [{ ticket: 'TRU-5' }, { stage: 'build' }, { round: 2 }]) {
    assert.deepEqual(failed(recordChecks({ ticket: 'TRU-6', records: all({ verify: rec('verify', over) }), statuses: added })), ['verify_passed']);
  }
});

test('a record that was edited or deleted fails the gate', () => {
  const statuses = [...added, ['M', '.sdlc/records/TRU-4/verify-1.json']];
  const checks = recordChecks({ ticket: 'TRU-6', records: all(), statuses });
  assert.deepEqual(failed(checks), ['records_append_only']);
  assert.match(checks.at(-1).detail, /M \.sdlc\/records\/TRU-4\/verify-1\.json/);
});

test('the change must be the one that was reviewed', () => {
  assert.equal(sameChange({ commit: '3b0baf3', reviewed: 'abc', head: 'abc' }).pass, true);
  assert.match(sameChange({ commit: '3b0baf3', reviewed: 'abc', head: 'def' }).detail, /back through Build/);
  assert.match(sameChange({ commit: '3b0baf3', reviewed: null, head: 'def' }).detail, /isn't in this branch/);
});

test('the PR names its ticket, has a Summary and a Test plan, and lists every open finding', () => {
  assert.deepEqual(failed(bodyChecks({ ticket: 'TRU-6', title: 'Drop fields', body, minor: 2 })), []);
  assert.deepEqual(failed(bodyChecks({ ticket: 'TRU-7', title: 'Drop fields', body, minor: 2 })), ['names_ticket']);
  assert.deepEqual(failed(bodyChecks({ ticket: 'TRU-6', title: 'Drop fields', body, minor: 3 })), ['findings_listed']);
  assert.deepEqual(failed(bodyChecks({ ticket: 'TRU-6', title: 'TRU-6', body: '## Summary\n\nx\n', minor: 0 })), ['body_shape']);
  assert.deepEqual(failed(bodyChecks({ ticket: 'TRU-6', title: 'TRU-6', body: '## Summary\n\nx\n\n## Test plan\n\nran it\n', minor: 0 })), ['body_shape']);
});
