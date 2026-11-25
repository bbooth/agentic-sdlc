---
name: verify-ticket
description: Take a built sub-ticket through the Verify gate, where an independent verifier runs each acceptance criterion. Use when a ticket is in the Verify stage, or when asked to verify a ticket for a project that uses this pipeline.
---

# Verify a ticket

`<plugin>` below is this plugin's root, two directories above this
skill's base directory. The project's own settings are in its
`.sdlc/config.json`. If it has none, stop and say the project hasn't set
up the pipeline: `onboard-project` sets it up. This plugin's
agents are launched as `sdlc:<name>`, e.g. `sdlc:verifier`.

You run the stage; you don't do the verifying and you don't fix anything.
The `verifier` agent tries each criterion against the running code, and
`check-verify.mjs` decides. If you wrote this ticket's code in this
session, say so and stop: the verifier must start without the author's
context.

## Before you start

- The ticket's Stage label is **Verify**, and its branch has a passing
  Build record in `.sdlc/records/<ID>/`.
- Verify needs what the Build gate could skip: whatever the project's
  `CLAUDE.md` Verification section needs (often Docker for database
  tests and the local stack), and a browser when the diff touches a UI.
  Without them, stop and say what's missing. Don't run a partial Verify.

## Steps

1. Check out the ticket's branch at its pushed head. Read the ticket: the
   criteria it covers are the `Covers` field.
2. Run the `verifier` agent with the ticket ID, the ticket's description,
   the base `origin/main` and the plugin root. If a criterion needs a
   check only the owner can make (an app on their phone), ask the owner
   for it, post their report or screenshot on the ticket as a comment,
   and give the verifier the owner's words and that comment's link. Save its JSON reply, unedited, as the
   verification file outside the repo.
3. Run the gate:
   `node <plugin>/bin/check-verify.mjs --ticket <ID> --criteria <AC-1,AC-2> --verification <file> --write --comment`
   (`--branch <name>` on a detached checkout.) It re-runs every test the
   verifier named. Run it standing in the ticket's branch with
   `SDLC_CONFIG` set to an up-to-date `main`'s config
   (`git fetch origin main && git show origin/main:.sdlc/config.json > <tmp>/config.json`),
   so an older branch is judged by today's rules. Never merge `main`
   into the branch here.
4. Commit the record it wrote under `.sdlc/records/<ID>/`, push, and post
   the gate's output as a comment on the ticket, pass or fail.
5. **On a pass**, swap the Stage label to **Adversarial review**. Don't
   open a PR.
6. **On a fail**, swap the Stage label back to **Build**. The author
   fixes what the record names through `build-ticket`, the Build gate
   runs again with its next round, and then Verify runs again with
   `--round` one higher. After three failed Verify rounds, set the Stage
   label to **Blocked** and report what won't pass.

## Rules

- Never edit the verification file to make the gate pass, and never
  change code in this stage. A wrong verdict is fixed by running the
  verifier again.
- A fail caused by the environment (Docker down, a port in use) isn't a
  round: delete the uncommitted record that run wrote, fix the
  environment and run the same round again.
- If the session doesn't list the `verifier` agent (it started on a
  branch older than the agent), start a general-purpose subagent with
  the body of `<plugin>/agents/verifier.md` as its
  instructions, tell it it may not edit, commit or push, and say in the
  ticket comment that you did.
- Post the gate's output as it is.
