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

- `plugins/sdlc/`: the Claude Code plugin.
  - `bin/`: the gate checks, one per stage (`check-spec.mjs` …
    `check-outcome.mjs`), `approve.mjs` for the owner's decisions, and
    `on-edit.mjs`, the edit hook. Plain Node 22, with no dependencies.
  - `constitution.md`: the standing rules every pipeline agent reads.
  - `templates/`: the shape of a spec and a plan, each with a worked
    example.
  - `schema/gate-record.schema.json`: what a gate writes down.
- `examples/booking/`: booking's `config.json` and `rollout.json`. The
  tests run against them.

Coming next: the skills, agents and hooks in the plugin, and reusable
workflows for the PR review gate and the rollout watch.

## What a project keeps

Everything about one project lives under its `.sdlc/`:

- `config.json`: what the gates need to know about this repo (below).
- `rollout.json`: where the Rollout gate looks: the namespace, the public
  address, Prometheus, and each service's smoke path and image inputs.
  Only a project that deploys with Argo Rollouts needs it.
- `constitution.md` (optional): rules that only this project has. Agents
  read it after the shared constitution.
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
