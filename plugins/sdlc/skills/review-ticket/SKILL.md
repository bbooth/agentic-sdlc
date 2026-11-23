---
name: review-ticket
description: Take a verified sub-ticket through Adversarial review, where a reviewer per scope attacks the diff and a judge tests their findings, then open its PR. Use when a ticket is in the Adversarial review stage, or when asked to review a ticket before its PR.
---

# Review a ticket before its PR

`<plugin>` below is this plugin's root, two directories above this
skill's base directory. The project's own settings are in its
`.sdlc/config.json`. If it has none, stop and say the project hasn't set
up the pipeline (the agentic-sdlc README says how). This plugin's
agents are launched as `sdlc:<name>`, e.g. `sdlc:verifier`.

You run the stage. The scope reviewers find problems, the `finding-judge`
tests the blocking ones, and `check-review.mjs` decides. You don't
review, judge or fix. If you wrote this ticket's code in this session,
say so and stop.

## Before you start

- The ticket's Stage label is **Adversarial review**, and its branch has
  a passing Verify record in `.sdlc/records/<ID>/`.
- Run the gate scripts standing in the ticket's branch with
  `SDLC_CONFIG` set to an up-to-date `main`'s config
  (`git fetch origin main && git show origin/main:.sdlc/config.json > <tmp>/config.json`),
  so an older branch still gets the current checks. Never merge `main` into the branch here: the gate fails if
  code changed since Verify.

## Steps

1. Check out the ticket's branch at its pushed head. Read the ticket.
2. `node <plugin>/bin/check-review.mjs --scopes` lists the reviewers this
   diff needs.
3. Run every listed reviewer agent at the same time, each with the
   ticket ID, the ticket's description, the base `origin/main` and the
   plugin root, and nothing else: not the Build or Verify records, and not each other's
   findings.
4. Give every blocking finding to the `finding-judge` agent, with the
   ticket, the base and the plugin root. Copy its `judged` and `reason` onto each.
5. Write the reviews file outside the repo, the reviewers' findings as
   they gave them:
   `{ "commit": "<short HEAD>", "reviews": [{ "scope": "security", "findings": [...] }] }`
6. Run the gate:
   `node <plugin>/bin/check-review.mjs --ticket <ID> --reviews <file> --write --comment`
   (`--branch <name>` on a detached checkout.)
7. Commit the record it wrote under `.sdlc/records/<ID>/`, push, and post
   the gate's output as a comment on the ticket, pass or fail.
8. **On a pass**, open the PR under `CLAUDE.md`'s Workflow:
   - Summary: what changed and why, and the ticket's ID and link.
   - Test plan: what the Verify record's evidence shows, and what wasn't
     verified.
   - "Open findings": every minor finding from the Verify and review
     records, as a checklist.
   - Add the labels the ticket's notes call for, e.g. `breaking-ok`.
     A label can only be added once the PR exists, so the first CI run
     starts without it; adding it starts the run that counts.
   Link the PR on the ticket, set its status to In Review, and swap the
   Stage label to **PR review**. Don't merge: the owner approves the
   merge.
   The `PR review` check on the PR is that stage's gate. If it fails on
   the description (ticket not named, no Test plan checklist, a finding
   missing from Open findings), fix the description; the check re-runs.
   If it fails on `same_change`, code changed after the review: the
   ticket goes back to Build. Never edit a record to make it pass.
9. **On a fail**, swap the Stage label back to **Build**. The confirmed
   blocking findings are the author's work list for `build-ticket`;
   then the Build gate, Verify and this review run again, each with its
   next round. After three failed review rounds, set the Stage label to
   **Blocked** and tell the owner what still stands and why it hasn't
   been fixed.

## Rules

- Never drop, reword or re-grade a finding. A reviewer's finding is
  wrong only when the judge refutes it.
- A minor finding doesn't fail the gate and isn't forgotten: it goes in
  the PR, where the owner decides.
- If the session doesn't list one of these agents (it started on a
  branch older than the agent), start a general-purpose subagent with
  the body of that agent's file in `<plugin>/agents/` as its instructions, tell it
  it may not edit, commit or push, and say in the ticket comment that
  you did.
- Post the gate's output as it is.
