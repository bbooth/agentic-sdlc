---
name: onboard-project
description: Set up a repo to use the ticket pipeline - write its .sdlc/config.json from what the repo has, turn on the plugin, add the CI callers, and open the PR. Use when asked to onboard, set up or add the SDLC pipeline to a repo, or when another pipeline skill stops because a repo has no .sdlc/config.json.
---

# Onboard a project

`<plugin>` below is this plugin's root, two directories above this
skill's base directory. `<plugin>/config.md` explains every file a
project keeps and every `config.json` key: read it before writing one.

You set the pipeline up; you don't change the project's code, and the
owner merges the result. Everything goes in one PR.

## Before you start

- Work on a branch from an up-to-date default branch. A repo with no
  commits has no branch to open a PR against: ask the owner to OK a
  README-only first commit on the default branch, push it, then branch
  from it.
- The first spec can come before onboarding: `spec-ticket`, `approve-gate`
  and `plan-ticket` run without a config. Build and every stage after it
  need this PR merged.
- If `.sdlc/config.json` already exists, this is a re-onboarding: run
  `node <plugin>/bin/check-config.mjs`, fix only what it reports and what
  the owner asked for, and keep the rest.

## Steps

1. **Read the repo.** `CLAUDE.md` and any area `CLAUDE.md` files, the
   README, CI workflows, and the build files (`go.mod`/`go.work`,
   `package.json`, `Cargo.toml`, `pyproject.toml`, a `Makefile`). Find:
   - the areas that build on their own, and the commands CI and
     `CLAUDE.md` run for each (build, lint, test). Prefer the repo's own
     commands to ones you make up.
   - generated code (a header saying so, or a generate step in CI) and
     the command that regenerates it.
   - test file conventions, migrations, SQL and the tests that run it
     against a real database.
   - what ships: the source, deploy and infra paths, as opposed to docs,
     CI and the pipeline's own files.
   - whether it deploys with Argo Rollouts (a Rollout in a chart, an
     ArgoCD Application).
   - the branch prefixes and status file `CLAUDE.md` asks for, if any.
   In a new or empty repo, take these from what the owner or the first
   spec says the project will be, and say in the PR which entries are
   plans rather than findings.
2. **Ask about the tracker** if nobody said: the Linear team (its key is
   the ticket prefix) and project. In Linear, check the team has the
   **Stage** label group (Intake, Spec, Ready for approval, Plan, Build,
   Verify, Adversarial review, PR review, Rollout, Outcome, Blocked) and
   the type labels Feature, Bug and Chore. Create the ones it lacks, and
   create the project if it doesn't exist. These steps can't be undone
   from here, so name what you'll create and get the owner's yes first.
3. **Write `.sdlc/config.json`.** Start from the closest file in
   `<plugin>/examples/`. Keep a `security` scope over every path
   (`"."`), and give the other reviewers only the paths they know:
   `review-api` for API definitions and handlers, `review-data` for SQL,
   stores and migrations, `review-operability` for services, deploy files
   and CI, `review-web` for a UI. Leave out a scope the repo has nothing
   for. Set `code` and `tests` for a language other than Go and
   TypeScript.
4. **Write `.sdlc/rollout.json`** only if the repo deploys with Argo
   Rollouts: the namespace, the public `https://` address, Prometheus,
   and each Rollout's service name, a path that answers without logging
   in (an unauthenticated 401 is fine), whether the service exports
   request metrics, and the paths its image is built from.
5. **Check them:** `node <plugin>/bin/check-config.mjs`. Fix every error.
   A warning for a path that doesn't exist yet is fine in a new repo; say
   so in the PR.
6. **Project rules for the agents** (optional). Where `CLAUDE.md` has
   rules a reviewer should hunt for, such as how tenancy works, which
   error an outsider gets, or what must never reach the chart, write them
   in `.sdlc/agents/<agent>.md`, one file per agent that needs them, as
   short "Look for:" bullets. Write them as pointers to `CLAUDE.md`, not
   copies of it. Rules every agent needs go in `.sdlc/constitution.md`.
7. **Turn the plugin on** in `.claude/settings.json`. Merge these into
   what's there and keep everything else:
   ```json
   {
     "extraKnownMarketplaces": {
       "agentic-sdlc": { "source": { "source": "github", "repo": "bbooth/agentic-sdlc" } }
     },
     "enabledPlugins": { "sdlc@agentic-sdlc": true }
   }
   ```
   If the repo has its own copy of the pipeline (`.sdlc/bin/`, or the
   stage skills and agents in `.claude/`), the switch-over removes it in
   the same PR, along with its hooks in `.claude/settings.json`. Keep its
   records.
8. **Add the CI callers** from `<plugin>/templates/workflows/`:
   `pr-review.yaml` always, and `rollout-watch.yaml` only with a
   `rollout.json`, into `.github/workflows/`. Replace `SDLC_SHA` in both
   `uses:` and `sdlc-ref` with the same commit: `git ls-remote https://github.com/bbooth/agentic-sdlc main`.
   The PR review gate runs on `vars.CI_RUNNER`, else `ubuntu-latest`;
   change that line if the repo's CI picks its runner another way. In
   `rollout-watch.yaml`, replace `RUNNER_LABEL` with a runner that can
   reach the cluster. If a workflow of
   the same name exists, replace its job and keep the file's name, so a
   required check keeps its name.
9. **Point to the pipeline in `CLAUDE.md`**: a short section saying work
   goes through the ticket pipeline (start with `spec-ticket`), and that
   `.sdlc/config.json` holds what the gates know about the repo.
10. **Open the PR.** Commit, push and open it with a Summary, a Test plan
    checklist (`check-config.mjs`'s output, which entries are plans), and
    a section **For the owner** listing what only they can do:
    - make `pr-review` a required check on the default branch;
    - add the `ROLLOUT_WATCH_KUBECONFIG` secret (a read-only kubeconfig
      for the app's cluster) and set the runner, if there's a rollout
      watch;
    - create the `no-ticket` label, and `breaking-ok` if CI reads it.
    Don't merge it: the owner does.

## Rules

- Don't change the project's code, its build or its other CI here. If
  onboarding shows something should change, say so in the PR.
- Never write a secret into a file, the PR or a comment.
- Until this PR merges, the PR review gate does nothing: it reads the
  base branch's config, and there isn't one yet.
