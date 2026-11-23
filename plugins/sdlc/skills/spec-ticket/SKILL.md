---
name: spec-ticket
description: Turn an idea, bug report or alert into a Linear ticket with a spec that passes the Spec gate. Use when asked to spec, ticket or write up a piece of work for a project that uses this pipeline.
---

# Spec a ticket

`<plugin>` below is this plugin's root, two directories above this
skill's base directory. The project's own settings are in its
`.sdlc/config.json`. If it has none, stop and say the project hasn't set
up the pipeline: `onboard-project` sets it up. This plugin's
agents are launched as `sdlc:<name>`, e.g. `sdlc:verifier`.

You are the planner. You write the ticket; you don't write code, a design
or a task list, and you never approve your own spec.

## Steps

1. Read the constitution (`<plugin>/constitution.md`, then the project's
   `.sdlc/constitution.md` if it has one),
   the project's glossary (`CONTEXT.md`) and its status file (the
   config's `statusFile`), where they exist. Read the code only as far as needed to state the problem accurately.
2. Search Linear for an open ticket covering the same thing. If there is
   one, say so and stop.
3. If the idea can be read two ways that would change the acceptance
   criteria, ask one question before writing. Otherwise pick the likely
   reading and put what you left out under Non-goals.
4. Write the spec to a scratch file in the shape of
   `<plugin>/templates/spec.md` (`spec.example.md` shows one filled in). Pick
   the Type and the Size first; the Size caps the number of criteria.
5. Run the gate:
   `node <plugin>/bin/check-spec.mjs <file> --comment`
   Fix what fails and re-run, raising `--round` each time. After three
   failed rounds, stop and report what won't pass.
6. Create the Linear issue in the team and project the config's
   `tracker` names: the spec's
   title as the title, the spec without its `#` title line as the
   description, status Backlog, and two labels: the Type (Feature, Bug or
   Chore) and the stage **Spec**. Assign it to the owner.
7. Re-run the gate with `--ticket <ID> --comment` and post its output as
   a comment on the issue. That comment is the gate record.
8. On a pass, swap the stage label to **Ready for approval**, set the
   status to Todo, and stop. The owner moves it to Plan; you never do.

## Rules

- Post the checker's output as it is. Don't write a gate record by hand
  or change its result.
- A success metric whose signal doesn't exist yet needs an acceptance
  criterion that creates it.
- If Linear isn't reachable, leave the spec and the gate output in the
  reply and say the ticket wasn't created. Don't put it anywhere else.
