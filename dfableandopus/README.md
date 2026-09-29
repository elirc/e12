# Job-readiness pack: feature flag platform (e12)

This folder turns the same codebase the `astraupskill/` course teaches into interview material for CRUD web-application roles. The course explains how the app works; this pack is about saying it out loud under time pressure.

## The one-paragraph pitch

I built and hardened a dependency-light feature flag administration platform in Node 22 with no runtime packages: projects, environments, flags, segments, strategies, variants, dependencies and scoped API tokens, persisted in a single JSON workspace. The two changes worth talking about are a durable write path and an evaluation correctness fix. The write path replaced a direct file write with an exclusive lease, a revision-and-digest precondition, a temp-file-plus-rename commit, and publication of the accepted bytes only after the rename succeeds (`src/server/storage.js:228-260`). The evaluation fix removed a conditional-response cache that keyed only on configuration identity, so two different user contexts could receive the same answer. Verification: 98 backend tests plus 20 Chromium workflows in 92.54 seconds, recorded in `astraupskill/VERIFICATION.md`.

## Target stacks

Primary framing is Node/JavaScript service work: HTTP boundary, validation, optimistic concurrency, authorization. Almost every answer maps cleanly onto ASP.NET Core (`If-Match` and `rowversion`) or a Postgres-backed Express/Nest service; where the JSON-file model is the weak point, say so and name the database version of the same invariant. That honesty is the strong answer here, not a liability.

## How to use this in two weeks

- Days 1-3: read `01-INTERVIEW-QUESTIONS.md` screening group, answer aloud without notes, then check citations on disk.
- Days 4-6: `03-CODE-READING-DRILL.md`, one drill per sitting, timed at 10 minutes, `<details>` closed until you commit to an answer.
- Days 7-8: rehearse `02-STORIES-AND-RESUME.md` until the 60-second summary is 60 seconds.
- Days 9-11: do `04-TAKE-HOME.md` for real against the existing `node --test` setup, then grade yourself with its rubric.
- Days 12-13: `05-SYSTEM-DESIGN-FOLLOWUPS.md` on a whiteboard, out loud.
- Daily: `06-FLASHCARDS.md`, 10 minutes.

## Files

- [01-INTERVIEW-QUESTIONS.md](01-INTERVIEW-QUESTIONS.md)
- [02-STORIES-AND-RESUME.md](02-STORIES-AND-RESUME.md)
- [03-CODE-READING-DRILL.md](03-CODE-READING-DRILL.md)
- [04-TAKE-HOME.md](04-TAKE-HOME.md)
- [05-SYSTEM-DESIGN-FOLLOWUPS.md](05-SYSTEM-DESIGN-FOLLOWUPS.md)
- [06-FLASHCARDS.md](06-FLASHCARDS.md)
