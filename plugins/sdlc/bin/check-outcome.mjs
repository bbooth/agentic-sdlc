#!/usr/bin/env node
// The Outcome gate, the last one. Every task of a ticket is live; this
// asks whether the ticket did what its spec said it would, by the spec's
// own success metrics. The `outcome-analyst` agent measures each metric on
// the cluster; this checks what it brought back. It reads no cluster
// itself. Exits 1 when the gate fails and 3 when a metric's window hasn't
// passed yet.
//
//   node bin/check-outcome.mjs --due --spec spec.md --live-at <ISO time>
//   node bin/check-outcome.mjs --ticket ABC-5 --spec spec.md --outcome outcome.json
//        [--round 2] [--comment]
//
// --due prints when the Outcome gate can first run: the last release's
// time plus the longest window a metric names. Nothing is written to the
// repo: the branches are gone, so this record lives in its ticket comment.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bullets, emit, parseArgs, record, requireConfig, sections } from './lib.mjs';

const UNIT_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
// What nobody in the pipeline may do to the cluster or its databases.
const WRITES = /\bkubectl\b.*\b(exec|apply|patch|delete|edit|replace|scale|annotate|label|cordon|drain|promote|abort|retry|restart|undo|set)\b|\bpsql\b|\bpg_dump\b/;

// The spec's success metrics, in order: M-1, M-2, ... `windowMs` is the
// longest stretch of time the metric names ("in the 24 hours after"), or 0.
export function metrics(spec) {
  return bullets(sections(spec)['Success metrics'] ?? '').map((line, i) => {
    // The signal runs to the line's last ")": a signal may hold its own,
    // e.g. a log pattern.
    const tail = line.match(/\s*\(signal: *(.+)\)\s*$/i);
    const text = (tail ? line.slice(0, tail.index) : line).trim();
    const windows = [...text.matchAll(/(\d+)[ -]?(minute|hour|day|week)s?\b/gi)].map((m) => Number(m[1]) * UNIT_MS[m[2].toLowerCase()]);
    return { id: `M-${i + 1}`, text, signal: tail?.[1].trim() ?? '', windowMs: Math.max(0, ...windows) };
  });
}

// When every metric's window has passed, counting from the last release.
export function dueAt(spec, liveAt) {
  return new Date(new Date(liveAt).getTime() + Math.max(0, ...metrics(spec).map((m) => m.windowMs)));
}

const hours = (ms) => `${Math.round(ms / 360_000) / 10}h`;

// `outcome` is the analyst's reply: { tasks: [{ id, rollout, live_at }],
// metrics: [{ id, verdict, measured_to, evidence: [{ command, observed }] }] }.
// Returns the checks, and `early` when the only thing wrong is the clock.
export function outcomeChecks({ spec, outcome }) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });
  const wanted = metrics(spec);
  const tasks = outcome.tasks ?? [];
  const got = outcome.metrics ?? [];

  const notLive = tasks.filter((t) => t.rollout !== 'pass' || Number.isNaN(Date.parse(t.live_at)));
  add('tasks_live', tasks.length > 0 && notLive.length === 0,
    tasks.length === 0 ? 'No tasks named' : notLive.length ? `No passing Rollout record with its time for: ${notLive.map((t) => t.id).join(', ')}` : `${tasks.map((t) => t.id).join(', ')} each passed the Rollout gate`);
  const live = Math.max(...tasks.map((t) => Date.parse(t.live_at)).filter((n) => !Number.isNaN(n)), 0);

  const missing = wanted.filter((m) => !got.some((g) => g.id === m.id && ['met', 'not_met', 'unknown'].includes(g.verdict))).map((m) => m.id);
  add('metrics_covered', wanted.length > 0 && missing.length === 0,
    wanted.length === 0 ? 'The spec has no success metrics' : missing.length ? `No verdict for: ${missing.join(', ')}` : `A verdict for each of ${wanted.map((m) => m.id).join(', ')}`);

  const judged = got.filter((g) => wanted.some((m) => m.id === g.id));
  const early = wanted.filter((m) => m.windowMs > 0).map((m) => {
    const to = Date.parse(judged.find((g) => g.id === m.id)?.measured_to);
    return { m, short: Number.isNaN(to) ? m.windowMs : live + m.windowMs - to };
  }).filter((e) => e.short > 0);
  add('window_passed', early.length === 0,
    early.length ? early.map((e) => `${e.m.id} needs ${hours(e.m.windowMs)} after the last release and was measured ${hours(e.short)} short of it`).join('; ')
      : 'Every metric was measured over the whole window it names');

  const bare = judged.filter((g) => !(g.evidence ?? []).some((e) => String(e.command ?? '').trim() && String(e.observed ?? '').trim())).map((g) => g.id);
  add('evidence', bare.length === 0, bare.length ? `No command and what it showed for: ${bare.join(', ')}` : `${judged.length} verdicts, each from something that was run`);

  const wrote = judged.flatMap((g) => (g.evidence ?? []).filter((e) => WRITES.test(String(e.command ?? ''))).map((e) => `${g.id} "${String(e.command).slice(0, 60)}"`));
  add('read_only', wrote.length === 0, wrote.length ? `Measured by changing the cluster or querying its database: ${wrote.join('; ')}` : 'Nothing was measured by changing the cluster');

  const unmet = judged.filter((g) => g.verdict !== 'met');
  add('metrics_met', missing.length === 0 && unmet.length === 0,
    unmet.length ? unmet.map((g) => `${g.id} is ${g.verdict === 'unknown' ? 'unknown' : 'not met'}`).join('; ') : missing.length ? 'Not every metric has a verdict' : 'Every success metric is met');

  const failed = checks.filter((c) => !c.pass).map((c) => c.name);
  return { checks, early: failed.length > 0 && failed.every((n) => n === 'window_passed') };
}

export const evidenceLines = (outcome) => (outcome.metrics ?? []).flatMap((g) => (g.evidence ?? []).map((e) => `${g.id} ${g.verdict}: ${e.command} -> ${e.observed}`));

function main(argv) {
  requireConfig();
  const { flags } = parseArgs(argv, ['--ticket', '--spec', '--outcome', '--live-at', '--round']);
  if (flags.due && flags.spec && flags['live-at']) {
    const spec = readFileSync(flags.spec, 'utf8');
    console.log(JSON.stringify({ due: dueAt(spec, flags['live-at']).toISOString(), metrics: metrics(spec) }, null, 2));
    return 0;
  }
  if (!flags.ticket || !flags.spec || !flags.outcome) {
    console.error('usage: check-outcome.mjs --due --spec spec.md --live-at <ISO time> | --ticket ID --spec spec.md --outcome outcome.json [--round N] [--comment]');
    return 2;
  }
  const spec = readFileSync(flags.spec, 'utf8');
  const outcome = JSON.parse(readFileSync(flags.outcome, 'utf8'));
  const { checks, early } = outcomeChecks({ spec, outcome });
  const r = record({
    stage: 'outcome', ticket: flags.ticket, round: Number(flags.round ?? 1),
    inputs: Object.fromEntries((outcome.tasks ?? []).map((t) => [t.id, `live ${t.live_at}`])),
    agent: { name: 'check-outcome', kind: 'deterministic' },
    checks, findings: outcome.findings ?? [], evidence: evidenceLines(outcome),
    pass: 'Done: the ticket did what its spec said',
    fail: early ? 'Not due yet: run this round again when the window has passed' : 'Blocked: the owner decides between fixing forward, reverting and accepting it',
  });
  const code = emit(r, flags);
  return code === 1 && early ? 3 : code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv);
