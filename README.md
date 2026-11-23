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
- `examples/booking/`: booking's `config.json` and `rollout.json`. The
  tests run against them.

- `.github/workflows/pr-review.yaml` and `rollout-watch.yaml`: reusable
  workflows for the PR review gate and the rollout watch, which projects
  call from their own CI.

## Using it in a project

1. Add `.sdlc/config.json` (below), and `.sdlc/rollout.json` if the
   project deploys with Argo Rollouts.
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
3. Call the PR review gate on every pull request, and make `pr-review`
   a required check on `main`. Pin both lines to the same agentic-sdlc
   commit, so a change here reaches the project only when it moves the pin:

   ```yaml
   # .github/workflows/pr-review.yaml
   name: PR review
   on:
     pull_request:
       types: [opened, synchronize, reopened, edited, labeled, unlabeled]
   concurrency:
     group: pr-review-${{ github.event.pull_request.number }}
     cancel-in-progress: true
   jobs:
     pr-review:
       uses: bbooth/agentic-sdlc/.github/workflows/pr-review.yaml@<sha>
       with:
         sdlc-ref: <sha>
   ```

   It judges the PR with the base branch's `.sdlc/config.json`, and does
   nothing until the base has one.
4. If the project deploys with Argo Rollouts, call the rollout watch after
   each merge. Give it a runner that can reach the cluster, and a
   read-only kubeconfig as a secret:

   ```yaml
   # .github/workflows/rollout-watch.yaml
   name: Rollout watch
   on:
     push:
       branches: [main]
     workflow_dispatch:
       inputs:
         ticket: { description: The ticket whose merge to watch, required: true }
         commit: { description: That ticket's merge commit on main, required: true }
         record: { description: Comment the record on the PR, type: boolean, default: false }
   concurrency:
     group: rollout-watch
     cancel-in-progress: false
   jobs:
     rollout-watch:
       uses: bbooth/agentic-sdlc/.github/workflows/rollout-watch.yaml@<sha>
       permissions:
         contents: read
         pull-requests: write
       with:
         sdlc-ref: <sha>
         runner: <a runner label>
         ticket: ${{ inputs.ticket }}
         commit: ${{ inputs.commit }}
         record: ${{ inputs.record || false }}
       secrets:
         kubeconfig: ${{ secrets.ROLLOUT_WATCH_KUBECONFIG }}
   ```

   It finds the ticket from the records the merge added, waits for the
   canary to finish, and comments the gate record on the merged PR.
5. Run `spec-ticket` on the first piece of work.

The skills find the scripts relative to their own directory, so they work
wherever the plugin is installed.

## What a project keeps

Everything about one project lives under its `.sdlc/`:

- `config.json`: what the gates need to know about this repo (below).
- `rollout.json`: where the Rollout gate looks: the namespace, the public
  address, Prometheus, and each service's smoke path and image inputs.
  Only a project that deploys with Argo Rollouts needs it.
- `constitution.md` (optional): rules that only this project has. Agents
  read it after the shared constitution.
- `agents/<agent>.md` (optional): what one agent should look for in this
  project, such as `agents/review-security.md` with the project's
  tenancy rules. Each agent reads its own file if there is one.
- `records/<ticket>/<stage>-<round>.json`: the gate records.

The scripts find the project from `CLAUDE_PROJECT_DIR`, else from the git
checkout they run in. `SDLC_CONFIG` and `SDLC_ROLLOUT` override where the
two files are read. CI uses `SDLC_CONFIG` to judge a PR by its base
branch's config, so a PR can't loosen its own gate. Without a config the
gates refuse to run (exit 2). The edit hook still runs its generic checks:
records are append-only, and Go files get gofmt and vet.

## `config.json`

Patterns are regular expressions, matched against paths relative to the
repo root.

| Key | What it's for |
|---|---|
| `tracker` | The ticket tracker: `kind` (`linear`), `team`, `key` (the ID prefix) and `project`. |
| `branchPrefixes` | The prefixes the Build gate accepts on a branch. |
| `statusFile` | A file every ticket's PR must update, such as `docs/STATUS.md`. Leave it out for none. |
| `generated.paths` | Generated files. They can't be edited by hand, and nothing counts or reviews them. |
| `generated.regenerate` | The command the edit hook suggests in place of a hand edit. |
| `unreviewed` | Other paths left out of size limits and review, such as lockfiles. |
| `ships` | Paths that reach production. A PR touching these needs a ticket's records, or the `no-ticket` label. |
| `tests` | What counts as a test file. |
| `migrations` | Migration files, which can't be edited once on `main`. An `.up.sql` needs its `.down.sql`. |
| `storeCode`, `storeTests` | Code that runs SQL, and the tests that run it against a real database. One needs the other. |
| `generatedWith` | Sources and the code generated from them, which must change together. `check` names the gate check, and `none`, `ok` and `missing` are its messages. |
| `areas` | The parts of the repo with their own commands. Each has a `name`, a `cwd`, the paths it covers (`when`), `commands`, and optionally `env`, a `tool` it needs, a path it `requires`, and `dockerTests` (without Docker, `go test` runs with `-short`). |
| `onEdit` | Linters for the edit hook: a `name`, the files they cover (`when`), `cmd`, `args` (`{file}` is the edited file), `cwd`, and optionally a path it `requires`. |
| `goWorkOff` | Go modules outside `go.work`, which build with `GOWORK=off`. |
| `evidence` | What Verify needs beyond tests: each kind (`e2e`, `browser`) and the paths that call for it. |
| `reviewScopes` | The Adversarial review's reviewers: each has a `name`, the `agent` that reviews it, and the `paths` that call for it. |

`examples/booking/config.json` is a complete example.

## Developing

```sh
npm test                 # the gate checks' tests, against the booking example
npm run check:examples   # the spec and plan examples pass their gates
```
