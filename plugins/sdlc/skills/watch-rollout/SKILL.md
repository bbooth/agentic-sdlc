---
name: watch-rollout
description: Follow a merged ticket's release onto the cluster and take it through the Rollout gate. Use when a ticket's PR has just merged, when a ticket is in the Rollout stage, or when asked whether a change is live.
---

# Watch a ticket's rollout

`<plugin>` below is this plugin's root, two directories above this
skill's base directory. The project's own settings are in its
`.sdlc/config.json`. If it has none, stop and say the project hasn't set
up the pipeline: `onboard-project` sets it up. This plugin's
agents are launched as `sdlc:<name>`, e.g. `sdlc:verifier`.

The canary's own analysis promotes or aborts a release; nobody here
does. You follow one merge to the cluster and record what happened.

## Before you start

- The ticket's PR is merged. Its merge commit is the `--commit`.
- You are on a machine whose `kubectl` can read the cluster. The cluster
  is read-only (and the project's deploy rules may say more): `get`, `describe`, `logs`,
  `get --raw`, `kubectl argo rollouts get`. Never promote, abort, retry,
  restart, exec or apply, whatever the rollout is doing.
- `git fetch` so `origin/main` is current: the gate reads the image
  digests ArgoCD Image Updater commits there, not your checkout. Run it
  from any checkout of `main`.

## Steps

1. If no PR review record is on the ticket yet, write down what was
   merged. From a checkout of `main`:
   `git fetch origin pull/<N>/head && git worktree add --detach <tmp> FETCH_HEAD`,
   then in `<tmp>` run `main`'s gate against the PR as it was merged:
   `SDLC_CONFIG=<main>/.sdlc/config.json node <plugin>/bin/check-pr.mjs --title "<PR title>" --body-file <PR body> --labels <its labels> --pr <N> --base <the PR's base sha> --comment`
   Post the output on the ticket as it is, pass or fail, then a comment
   that the owner merged the PR (who, when, which commit), and swap the
   Stage label to **Rollout**. A fail here doesn't undo the merge: say
   so to the owner and carry on with the rollout.
2. If the `Rollout watch` workflow already commented a Rollout record
   on the merged PR for this merge commit, use that as the gate's output
   and go to step 4. Otherwise run the gate:
   `node <plugin>/bin/check-rollout.mjs --ticket <ID> --commit <merge commit> --wait 30 --comment`
   It works out which images the merge rebuilds, waits for Image Updater
   to commit each one (they arrive minutes apart, after CI on `main`)
   and for each Rollout to settle or abort, reads the analysis runs and
   the new pods, sends a few unauthenticated GETs to the public address,
   and checks the new pods counted them without a server fault.
3. Exit code 3 and "Not finished yet" mean the wait ran out, not that
   anything failed: run the same round again and post nothing.
4. Post the gate's output as a comment on the ticket, pass or fail.
   Nothing is committed: the branch is gone, so this record lives on the
   ticket.
5. **On a pass**, swap the Stage label to **Outcome** and set the status
   to Done. Say on any ticket that was waiting for this release (its
   description says so, or it is blocked by this one) that it's live.
   If this was the last task of its parent to go live, swap the parent's
   Stage label to **Outcome**, and say on the parent when its Outcome
   gate is due (`check-outcome.mjs --due`, see `measure-outcome`).
6. **On a fail**, run the `rollout-investigator` agent with the ticket
   ID, the merge commit, the gate's output and the services. Post its
   reply as a second comment, swap the Stage label to **Blocked**, and
   tell the owner now: what is serving, the cause if it was found, and
   the options. Reverting, fixing forward and retrying are the owner's
   call and go through a new ticket or their say-so.

## Rules

- The smoke requests are refused (401) before any handler runs. They
  show the new pods are reachable and answering through the public path,
  not that the ticket's behavior works; Verify showed that.
- Don't send traffic other than the gate's own smoke requests.
- Post the gate's output as it is.
