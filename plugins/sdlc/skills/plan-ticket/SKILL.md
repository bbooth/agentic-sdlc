---
name: plan-ticket
description: Split a Linear ticket whose spec is approved into PR-sized sub-tickets, with a plan that passes the Plan gate. Use when a ticket is in the Plan stage, or when asked to plan a ticket for a project that uses this pipeline.
---

# Plan a ticket

`<plugin>` below is this plugin's root, two directories above this
skill's base directory. The project's own settings are in its
`.sdlc/config.json`. This stage can run before it has one, as a new
project's first spec usually does: take the tracker from the owner, and
say `onboard-project` must run before Build. This plugin's
agents are launched as `sdlc:<name>`, e.g. `sdlc:verifier`.

You are the planner. You decide how the work is cut up; you don't write
the code.

## Before you start

The ticket's Stage label is **Plan**, and its comments hold a passing
"Gate: Spec approval" record for the spec version in its description. If
either is missing, stop and say so: the owner approves a spec, nobody else.

## Steps

1. Read the constitution (`<plugin>/constitution.md`, then the project's
   `.sdlc/constitution.md` if it has one),
   `CLAUDE.md` and the area `CLAUDE.md`
   files for what the ticket touches. Read the code the change lands in:
   a plan names real files and the pattern it follows.
2. Save the ticket's description to a scratch file as the spec.
3. Write the plan to a second scratch file in the shape of
   `<plugin>/templates/plan.md` (`plan.example.md` shows one filled in).
   - A task is one PR that leaves `main` working and releasable.
   - Cut along release boundaries first: anything the constitution says
     must ship a release apart is separate tasks, the later depending on
     the earlier.
   - A task's Tests say how each criterion it covers is checked, by the
     "done" rules in `CLAUDE.md`.
4. Run the gate:
   `node <plugin>/bin/check-plan.mjs <spec> <plan> --comment`
   Fix what fails and re-run, raising `--round`. After three failed
   rounds, stop and report what won't pass.
5. Post the plan as a comment on the ticket, then re-run the gate with
   `--ticket <ID> --comment` and post its output as a second comment.
6. On a pass, create one sub-issue per task under the ticket: the task's
   title, its fields and the criteria it covers (copied from the spec) as
   the description, the parent's Type label, the stage **Build**, status
   Todo, and `blockedBy` for each task it depends on.
7. Swap the parent's stage label to **Build** and stop.

## Rules

- Post the checker's output as it is.
- Don't change the spec. If planning shows the spec is wrong or can't be
  met, say so on the ticket, move it back to **Spec**, and stop.
- If Linear isn't reachable, leave the plan and the gate output in the
  reply and say nothing was created.
