---
name: measure-outcome
description: Take a ticket whose tasks are all live through the Outcome gate, where an analyst measures the spec's success metrics on the cluster. Use when a ticket is in the Outcome stage and due, or when asked whether a released ticket did what it was meant to.
---

# Measure a ticket's outcome

`<plugin>` below is this plugin's root, two directories above this
skill's base directory. The project's own settings are in its
`.sdlc/config.json`. If it has none, stop and say the project hasn't set
up the pipeline: `onboard-project` sets it up. This plugin's
agents are launched as `sdlc:<name>`, e.g. `sdlc:verifier`.

Rollout asks whether the release is running. Outcome asks whether the
ticket did what its spec said it would, by the spec's own success
metrics. You run the stage; the `outcome-analyst` agent measures, and
`check-outcome.mjs` decides.

## Before you start

- The ticket is the one with the spec: a parent whose sub-tickets are
  all Done with a passing Rollout record, or a ticket built as one task.
- Save the ticket's description as the spec file, outside the repo.
- From each task's Rollout record take `recorded_at`: that is its
  `live_at`.
- `node <plugin>/bin/check-outcome.mjs --due --spec <spec> --live-at <the latest live_at>`
  prints when the gate can first run: the last release plus the longest
  window a metric names. Before then, say when it's due and stop.
- You are on a machine whose `kubectl` can read the cluster. The cluster
  is read-only (and the project's deploy rules may say more).

## Steps

1. Run the `outcome-analyst` agent with the ticket ID, the spec, the
   plugin root and the tasks as `[{ id, rollout: "pass", live_at }]`. Give it nothing from
   the Build, Verify or review records. Save its JSON reply, unedited,
   as the outcome file outside the repo.
2. Run the gate from a checkout of `main`:
   `node <plugin>/bin/check-outcome.mjs --ticket <ID> --spec <spec> --outcome <file> --comment`
3. Exit code 3 and "Not due yet" mean a metric's window hasn't passed:
   post nothing, and run the same round again when it has.
4. Post the gate's output as a comment on the ticket, pass or fail.
   Nothing is committed: this record lives on the ticket.
5. **On a pass**, set the Stage label to **Outcome** and the status to
   Done. List in the comment every finding the tasks' PRs left open and
   that has no ticket, so the owner can ticket or drop each.
6. **On a fail**, set the Stage label to **Blocked** and tell the owner
   now: which metric isn't met or couldn't be measured, what the analyst
   saw, and the options. Fixing forward is a new ticket through
   `spec-ticket`; reverting and accepting the result as it is are the
   owner's call. A metric that can't be measured read-only (it needs a
   database query, or logs that are gone) is the owner's to settle: they
   can run the check themselves and say what they saw, and you record
   their words on the ticket.

## Rules

- Never edit the outcome file, and never turn an `unknown` into `met`.
  A wrong verdict is fixed by running the analyst again.
- A metric the spec got wrong (it can't be read from its signal) is a
  finding about the spec, not a reason to pass.
- If the session doesn't list the `outcome-analyst` agent, start a
  general-purpose subagent with the body of
  `<plugin>/agents/outcome-analyst.md` as its instructions,
  tell it it may not edit, commit, push or change the cluster, and say
  in the ticket comment that you did.
- Post the gate's output as it is.
