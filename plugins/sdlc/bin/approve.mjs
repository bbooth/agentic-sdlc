#!/usr/bin/env node
// Writes the gate record for a decision only the owner makes: approving a
// spec, a merge or a production promotion. Run it only on the owner's own
// word, and quote that word with --said.
//
//   node bin/approve.mjs --ticket ABC-12 --stage spec --said "I approve" [--reject] [--spec-version 2] [--comment]

import { pathToFileURL } from 'node:url';
import { emit, parseArgs, record, requireConfig } from './lib.mjs';

// The stages with an owner decision, and where a ticket goes on a yes.
const NEXT = { spec: 'Advance to Plan', pr_review: 'Merge, then advance to Rollout', rollout: 'Promote to production, then advance to Outcome' };
const BACK = { spec: 'Back to Spec: revise', pr_review: 'Back to Build', rollout: 'Roll back and reopen' };

export function approvalRecord({ stage, said, reject = false, specVersion = '1', ...opts }) {
  return record({
    ...opts,
    stage,
    inputs: { spec_version: specVersion },
    agent: { name: 'owner', kind: 'human' },
    checks: [{ name: 'owner_approval', pass: !reject, detail: `The owner said: "${said}"` }],
    pass: NEXT[stage],
    fail: BACK[stage],
  });
}

function main(argv) {
  requireConfig();
  const { flags } = parseArgs(argv, ['--ticket', '--stage', '--said', '--spec-version', '--round']);
  if (!flags.ticket || !(flags.stage in NEXT) || typeof flags.said !== 'string' || !flags.said.trim()) {
    console.error(`usage: approve.mjs --ticket ID --stage ${Object.keys(NEXT).join('|')} --said "the owner's words" [--reject] [--spec-version N] [--round N] [--comment]`);
    return 2;
  }
  const r = approvalRecord({
    stage: flags.stage, said: flags.said.trim(), reject: Boolean(flags.reject),
    specVersion: flags['spec-version'] ?? '1', ticket: flags.ticket, round: Number(flags.round ?? 1),
  });
  // A rejection is a valid record, not a failed run.
  emit(r, flags);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv);
