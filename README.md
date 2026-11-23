# agentic-sdlc

A ticket pipeline for Claude-built projects. Every piece of work is a
ticket that moves through gated stages: Spec, Plan, Build, Verify,
Adversarial review, PR review, Rollout, Outcome. A stage's gate must pass
before the ticket moves, and the owner signs off only on the spec and the
merge.

The pipeline was first built in `bbooth/booking` (its ADR 0009). This repo
holds the parts that every project can share, and each project keeps its
own settings.

## Layout

- `.claude-plugin/marketplace.json`: makes this repo a plugin
  marketplace with one plugin, `sdlc`.
- `plugins/sdlc/`: the Claude Code plugin.
  - `skills/`: one skill per stage: `spec-ticket`, `plan-ticket`,
    `approve-gate`, `build-ticket`, `verify-ticket`, `review-ticket`,
    `watch-rollout` and `measure-outcome`.
  - `agents/`: the agents the skills start, each read-only. They are
    named `sdlc:<name>`: `sdlc:task-reviewer`, `sdlc:verifier`, a
    reviewer per scope (`sdlc:review-security`, `-api`, `-data`,
    `-operability`, `-web`), `sdlc:finding-judge`,
    `sdlc:rollout-investigator` and `sdlc:outcome-analyst`.
  - `hooks/hooks.json`: runs `bin/on-edit.mjs` before and after every
    Edit and Write.
  - `bin/`: the gate checks, one per stage (`check-spec.mjs` …
    `check-outcome.mjs`), `approve.mjs` for the owner's decisions, and
    `on-edit.mjs`, the edit hook. Plain Node 22, with no dependencies.
  - `constitution.md`: the standing rules every pipeline agent reads.
  - `templates/`: the shape of a spec and a plan, each with a worked
    example.
  - `schema/gate-record.schema.json`: what a gate writes down.
  - `config.md`: a project's settings, key by key, and `examples/`:
    booking's `config.json` and `rollout.json`, which the tests run
    against, and a small Rust one.
  - `templates/workflows/`: the CI callers a project copies.

- `.github/workflows/pr-review.yaml` and `rollout-watch.yaml`: reusable
  workflows for the PR review gate and the rollout watch, which projects
  call from their own CI.

## Using it in a project

The `onboard-project` skill does all of this in one PR: turn the plugin
on for yourself (`/plugin install sdlc --marketplace bbooth/agentic-sdlc`)
and ask Claude to onboard the repo. By hand:

1. Add `.sdlc/config.json`, and `.sdlc/rollout.json` if the project
   deploys with Argo Rollouts (see `plugins/sdlc/config.md`).
2. Turn the plugin on for everyone who works in the repo, Claude Code
   cloud sessions included, in the project's `.claude/settings.json`:

   ```json
   {
     "extraKnownMarketplaces": {
       "agentic-sdlc": { "source": { "source": "github", "repo": "bbooth/agentic-sdlc" } }
     },
     "enabledPlugins": { "sdlc@agentic-sdlc": true }
   }
   ```

   Or install it for yourself only:
   `/plugin install sdlc --marketplace bbooth/agentic-sdlc`.
3. Call the PR review gate on every pull request: copy
   `plugins/sdlc/templates/workflows/pr-review.yaml` to
   `.github/workflows/`, and make `pr-review` a required check on `main`.
   Pin its `uses:` and `sdlc-ref` to the same agentic-sdlc commit, so a
   change here reaches the project only when it moves the pin. It judges the PR with the base branch's `.sdlc/config.json`, and does
   nothing until the base has one.
4. If the project deploys with Argo Rollouts, call the rollout watch after
   each merge: copy `plugins/sdlc/templates/workflows/rollout-watch.yaml`,
   pinned the same way, with a runner that can reach the cluster and a
   read-only kubeconfig in the `ROLLOUT_WATCH_KUBECONFIG` secret. It finds the ticket from the records the merge added, waits for the
   canary to finish, and comments the gate record on the merged PR.
5. Run `spec-ticket` on the first piece of work.

The skills find the scripts relative to their own directory, so they work
wherever the plugin is installed.

## What a project keeps

A project's own settings live under its `.sdlc/`. The plugin's
[`config.md`](plugins/sdlc/config.md) explains each file and every
`config.json` key, and `plugins/sdlc/examples/` has a complete config for
booking and a small one for a Rust project.

## Developing

```sh
npm test                 # the gate checks' tests, against the booking example
npm run check:examples   # the spec and plan examples pass their gates
```
