// Shared by the gate checkers: the project's config, reading the markdown
// shapes in templates/, and writing a gate record and its ticket comment.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The project being gated: Claude Code's project dir, else the git checkout
// the script runs in. Records, config and rollout settings live under its .sdlc/.
export function projectRoot() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return process.cwd(); }
}

// What the checks know about the project, from its .sdlc/config.json.
// SDLC_CONFIG points elsewhere: CI points it at the base branch's copy, so
// a PR can't loosen its own gate. Without one, `config` is empty: the edit
// hook still runs its generic checks, and every gate refuses to judge.
export const CONFIG_PATH = process.env.SDLC_CONFIG || join(projectRoot(), '.sdlc/config.json');
export const configured = existsSync(CONFIG_PATH);
export const config = configured ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};

// Call first in a gate's main(): a gate run with no config would pass
// things the project's rules fail.
export function requireConfig() {
  if (configured) return;
  console.error(`No SDLC config at ${CONFIG_PATH}. Each project keeps one in .sdlc/config.json; see the agentic-sdlc README.`);
  process.exit(2);
}

// Config patterns are strings; these are what the checks match with.
export const patterns = (list = []) => list.map((p) => new RegExp(p));
export const matchesAny = (res, f) => res.some((re) => re.test(f));

export const PLACEHOLDER = /\b(TBD|TODO|FIXME)\b|<[A-Za-z][^<>\n]*>/;

// Linear stores a "-" bullet as "*", so text read back from a ticket has either.
export function field(text, name) {
  const m = text.match(new RegExp(`^[-*] \\*\\*${name}:\\*\\*[ \\t]*(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

function split(text, hashes) {
  const out = [];
  const parts = text.split(new RegExp(`^${hashes} +(.+)$`, 'm'));
  for (let i = 1; i < parts.length; i += 2) out.push({ heading: parts[i].trim(), body: parts[i + 1] });
  return out;
}

export const sections = (text) => Object.fromEntries(split(text, '##').map((s) => [s.heading, s.body]));
export const subsections = (body) => split(body, '###');
export const bullets = (body) => (body.match(/^[-*] +\S.*$/gm) ?? []).map((l) => l.replace(/^[-*] +/, ''));

// "AC-1: title" headings, in order from 1.
export function numbered(items, prefix) {
  const bad = items.filter((c, i) => !c.heading.startsWith(`${prefix}-${i + 1}:`)).map((c) => c.heading);
  return { ok: items.length > 0 && bad.length === 0, bad };
}

export const STAGE_TITLES = {
  intake: 'Intake', spec: 'Spec', plan: 'Plan', build: 'Build', verify: 'Verify',
  adversarial_review: 'Adversarial review', pr_review: 'PR review', rollout: 'Rollout', outcome: 'Outcome',
};

export function record({ stage, ticket = null, round = 1, now = new Date(), inputs, agent, checks, findings = [], evidence = [], pass, fail }) {
  const ok = checks.every((c) => c.pass);
  return {
    schema: 1,
    stage,
    ticket,
    round,
    result: ok ? 'pass' : 'fail',
    recorded_at: now.toISOString(),
    inputs,
    agent,
    checks,
    findings,
    decision: ok ? pass : fail,
    evidence,
  };
}

// The ticket comment: readable first, with the record itself underneath.
export function comment(r) {
  const title = STAGE_TITLES[r.stage] + (r.agent.kind === 'human' ? ' approval' : '');
  const inputs = Object.entries(r.inputs).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ');
  return [
    `### Gate: ${title} (${r.result}) · round ${r.round}`,
    `- Inputs: ${inputs}`,
    `- Agent: ${r.agent.name} (${r.agent.kind})`,
    '- Checks:',
    ...r.checks.map((c) => `  - ${c.pass ? 'pass' : 'FAIL'} ${c.name}: ${c.detail}`),
    `- Decision: ${r.decision}`,
    '',
    // Linear's collapsible section; it doesn't render <details>.
    '+++ Gate record',
    '',
    '```json',
    JSON.stringify(r, null, 2),
    '```',
    '',
    '+++',
  ].join('\n');
}

// Splits argv into positional arguments and --flags; `valued` flags take the next argument.
export function parseArgs(argv, valued) {
  const files = [];
  const flags = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) files.push(a);
    else if (valued.includes(a)) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  }
  return { files, flags };
}

export function emit(r, flags) {
  console.log(flags.comment ? comment(r) : JSON.stringify(r, null, 2));
  return r.result === 'pass' ? 0 : 1;
}
