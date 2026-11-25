# A project's settings

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

`bin/check-config.mjs` checks a project's config and rollout settings.

Patterns are regular expressions, matched against paths relative to the
repo root.

| Key | What it's for |
|---|---|
| `tracker` | The ticket tracker: `kind` (`linear`), `team`, `key` (the ID prefix) and `project`. |
| `branchPrefixes` | The prefixes the Build gate accepts on a branch. |
| `statusFile` | A file every ticket's PR must update, such as `docs/STATUS.md`. Leave it out for none. |
| `generated.paths` | Generated files. They can't be edited by hand, and nothing counts or reviews them. |
| `generated.regenerate` | The command the edit hook suggests in place of a hand edit. |
| `unreviewed` | Other paths left out of size limits and review. Common lockfiles (`Cargo.lock`, `package-lock.json`, `go.sum` and the like) and whole deleted files never count toward size anyway, but are still reviewed unless listed here. |
| `ships` | Paths that reach production. A PR touching these needs a ticket's records, or the `no-ticket` label. |
| `tests` | What counts as a test file. Test lines count at half toward a task's size. |
| `code` | Source files that need a test changed with them. Defaults to Go, TypeScript, Vue, `.mjs` and SQL. A Rust project sets `["\\.rs$"]` and keeps its tests in files the `tests` patterns match, because a test inline in the same file can't be told apart. |
| `migrations` | Migration files, which can't be edited once on `main`. An `.up.sql` needs its `.down.sql`. |
| `storeCode`, `storeTests` | Code that runs SQL, and the tests that run it against a real database. One needs the other. |
| `generatedWith` | Sources and the code generated from them, which must change together. `check` names the gate check, and `none`, `ok` and `missing` are its messages. |
| `areas` | The parts of the repo with their own commands. Each has a `name`, a `cwd`, the paths it covers (`when`), `commands`, and optionally `env`, a `tool` it needs, a path it `requires`, and `dockerTests` (without Docker, `go test` runs with `-short`). |
| `onEdit` | Linters for the edit hook: a `name`, the files they cover (`when`), `cmd`, `args` (`{file}` is the edited file), `cwd`, and optionally a path it `requires`. |
| `goWorkOff` | Go modules outside `go.work`, which build with `GOWORK=off`. |
| `evidence` | What Verify needs beyond tests: each kind (`e2e`, `browser`) and the paths that call for it. |
| `reviewScopes` | The Adversarial review's reviewers: each has a `name`, the `agent` that reviews it, and the `paths` that call for it. |

`examples/booking/config.json` is a complete example, and
`examples/rust/config.json` a small one for a Cargo workspace.
