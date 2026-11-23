# Constitution

The standing rules every SDLC agent reads before it writes a spec, a plan,
code or a review, in every project that uses this pipeline. It adds to the
project's `CLAUDE.md` files and repeats none of them; where they differ,
those win. A project adds its own rules in `.sdlc/constitution.md`, which
an agent reads after this one. Change this file by PR to agentic-sdlc.

## Specs

- A spec says what must be true and how we'll know, never how to build it.
- Use the words in `CONTEXT.md`. A new term goes into `CONTEXT.md` in the
  same ticket.
- Size sets how much spec a ticket gets: S has 1 to 3 acceptance criteria,
  M has 2 to 6, L has 3 to 10. Anything needing more is split.
- Every criterion is a Given, When, Then that a test or a person at the
  running app can check. "Works correctly" isn't a criterion.
- Every success metric names the signal it's read from. If the signal
  doesn't exist yet, creating it is an acceptance criterion.
- Say what's left out under Non-goals, so a reviewer can tell an omission
  from a decision.

## Quality

- A change meets its ticket's acceptance criteria, each covered by a test
  that fails without the change.
- "Done" is the Verification section of `CLAUDE.md`, not a green unit test.

## Reliability

- Every call that leaves the process has a timeout. Retries are bounded
  and only on calls that are safe to repeat.
- Errors are returned or logged with what was being attempted, never
  swallowed.
- Schema changes roll forward and back across one release: add first,
  remove in the release after.

## Maintainability

- Follow the pattern the area already uses before adding a new one. A new
  pattern is an ADR.
- A PR does one ticket's work. Refactors that the ticket doesn't need go in
  their own ticket.

## Observability

- A new endpoint, job or sweep logs its outcome with structured fields and
  has a metric for its rate, errors and duration.
- A signal named in a spec's success metrics exists before the ticket
  reaches Rollout.

## Gates

- A ticket moves forward only when its stage's gate record says pass.
- Whoever did the work never judges it: the author doesn't review, and a
  reviewer doesn't edit code.
- Gate records are append-only. A new round is a new record.
- The owner approves the spec, the merge and the production promotion.
