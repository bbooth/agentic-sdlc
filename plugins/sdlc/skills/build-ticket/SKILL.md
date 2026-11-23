---
name: build-ticket
description: Implement one Build-stage sub-ticket on a branch and take it through the Build gate. Use when asked to build, implement or start a ticket for this repo that came out of the Plan stage.
---

# Build a ticket

`<plugin>` below is this plugin's root, two directories above this
skill's base directory. The project's own settings are in its
`.sdlc/config.json`. If it has none, stop and say the project hasn't set
up the pipeline: `onboard-project` sets it up. This plugin's
agents are launched as `sdlc:<name>`, e.g. `sdlc:verifier`.

You are the author. You write the code and its tests for one task, and
you don't judge your own work: the hooks, the task reviewer and the Build
gate do.

## Before you start

- The ticket is a sub-ticket whose Stage label is **Build**, and every
  ticket it's blocked by is Done. If its description says to wait for a
  release, check that release is live. Otherwise stop and say what it's
  waiting on.
- Read the ticket, its parent's spec and plan comments,
  the constitution (`<plugin>/constitution.md`, then the project's
  `.sdlc/constitution.md` if it has one), `CLAUDE.md` and the area
  `CLAUDE.md` files.

## Steps

1. Branch from an up-to-date `main`, named with one of the config's
   `branchPrefixes` and the ticket ID, e.g. `backend/abc-6-drop-old-fields`. Set the
   ticket's status to In Progress.
2. Write the test for each acceptance criterion the task covers first,
   see it fail, then make it pass.
3. Edit as usual. The plugin's hooks run on every edit
   (`<plugin>/bin/on-edit.mjs`): they refuse hand edits to generated code,
   merged migrations and gate records, and they format-check and vet what
   you just wrote. Fix what a hook reports before the next edit; never
   work around one.
4. Do the Verification section of `CLAUDE.md` for what you changed. What
   you can't verify here, write down for the PR; don't claim it.
5. Update the config's `statusFile` if it names one, and add an ADR for a choice someone would
   want to revisit. Commit.
6. Run the `task-reviewer` agent with the ticket ID, the ticket's
   description, the base `origin/main` and the plugin root. Save its JSON reply as the
   findings file.
7. Fix every blocking finding and commit. In the findings file set each
   one's `status` to `fixed`, or to `dismissed` with a `reason` only when
   the finding is wrong, and say why. You may not dismiss a finding
   because fixing it is hard.
8. Run the gate:
   `node <plugin>/bin/check-build.mjs --ticket <ID> --size <S|M> --findings <file> --write --comment`
   On a fail, fix, commit, and re-run with the next `--round`. After
   three failed rounds, stop: set the Stage label to **Blocked** and
   report what won't pass.
9. On a pass, commit the record it wrote under `.sdlc/records/<ID>/`,
   push the branch, post the gate's output as a comment on the ticket,
   and swap the Stage label to **Verify**. Don't open a PR: that comes
   after Adversarial review. On a ticket sent back from Verify or
   Adversarial review, the findings in that record are the work list.

## Rules

- One ticket, one branch. Work the ticket didn't ask for goes in a new
  ticket through `spec-ticket`.
- Post the checker's output as it is, including what it says wasn't run.
- If the task can't meet its criteria as planned, say so on the ticket,
  set the Stage label to **Blocked**, and stop.
