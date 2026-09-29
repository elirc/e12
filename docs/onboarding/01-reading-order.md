> Historical documentation: this page describes the original implementation. Setup, storage, SDK evaluation, authorization, and the administration UI have changed. Start with the [current CRUD learning course](../../astraupskill/README.md); use this page for before/after comparison.

# Reading Order

This codebase is small enough that you can understand the whole system, but you will learn faster if you read it in layers instead of file-by-file in arbitrary order.

The order below is optimized for:

- getting oriented quickly
- learning the runtime path before implementation details
- seeing where business rules live
- building review instincts along the way

## Stage 1: Start With The Big Picture

Read:

- `README.md`
- `src/server/server.js`

Why this comes first:

- `README.md` tells you what the app is trying to be.
- `server.js` is the thinnest real entry point and shows the top-level shape: static UI + API routes + a store + a service layer.

What to learn here:

- how the application boots
- what runs in one Node process
- where HTTP requests first enter the system
- that the app is intentionally layered, even though it is small

After this stage, you should understand:

- where the app starts
- which files look like boundaries rather than helpers
- that `createAppServer()` is wiring, not business logic

## Stage 2: Read The HTTP Boundary

Read:

- `src/server/router.js`

Why this stage comes next:

- once you know where requests enter, the next question is how the app decides what to do with them
- this file shows the public API surface more clearly than any other file

What to learn here:

- which endpoints exist
- how route matching works in this repo
- where query parsing and JSON body parsing happen
- how the code separates transport logic from domain logic

After this stage, you should understand:

- the difference between `/api/admin/*`, `/api/client/*`, and `/api/metrics/*`
- that routes mostly delegate to services instead of implementing rules inline
- how errors are normalized into JSON responses

## Stage 3: Study The Service Layer Carefully

Read:

- `src/server/services.js`

Why this stage comes here:

- this is the core orchestration layer, and it only makes sense once you already know the route surface
- it is the highest-leverage file for both debugging and code review

What to learn here:

- where authorization and scope checks happen
- how project scoping and environment protection are enforced
- how audit logs are produced
- how mutations are structured before being handed to persistence
- which invariants the code treats as important

After this stage, you should understand:

- why business logic belongs here instead of in routes or UI code
- which mutations invalidate cached evaluation state indirectly through the store
- which operations are sensitive enough to require extra confirmation

## Stage 4: Understand Persistence And Snapshotting

Read:

- `src/server/store.js`
- `src/core/snapshot.js`

Why this stage comes after services:

- once you understand writes and reads conceptually, the next question is how state is stored and transformed for fast evaluation

What to learn here:

- how the JSON store works
- why mutations use `structuredClone(...)`
- how `meta.version` and `etag` are used
- why snapshots are compiled per project/environment instead of evaluating directly from raw state every time

After this stage, you should understand:

- how config changes become evaluation-visible
- why cache invalidation is part of correctness here, not just performance
- how the app expresses the control-plane vs evaluation-plane split in code

## Stage 5: Learn The Evaluator

Read:

- `src/core/evaluation.js`

Why this stage comes here:

- by now you already know where snapshots come from and how they are requested
- that makes the evaluator much easier to reason about

What to learn here:

- how individual constraints are matched
- how segments are merged into strategy constraints
- how gradual rollout bucketing works
- how variants are picked deterministically
- how dependency checks and archived flags short-circuit evaluation

After this stage, you should understand:

- what "deterministic rollout" means in practice
- why order matters when multiple strategies match
- which edge cases could accidentally enable or disable a flag

## Stage 6: Read The Admin UI

Read:

- `src/ui/app.js`

Why this stage comes after the server/core layers:

- the UI is easier to follow once you already know what the APIs do
- otherwise you risk reading it as a pile of DOM manipulation instead of as user workflows

What to learn here:

- how the page bootstraps its initial state
- how project and environment selection drive subsequent actions
- how one UI event becomes an API call and then a re-render
- where the UI is opinionated vs generic

After this stage, you should understand:

- the main admin workflows
- what data the UI depends on from `/api/admin/bootstrap`
- where UI state can get out of sync with server truth

## Stage 7: Use Tests To Confirm Your Mental Model

Read:

- `test/evaluation.test.js`
- `test/services.test.js`

Why this stage is last:

- tests are most useful once you already have a theory of how the system works
- then you can compare your theory to what the repo actually guards

What to learn here:

- which behaviors are explicitly protected
- which invariants are missing test coverage
- how to write focused tests around small but important rules

After this stage, you should understand:

- which bugs the codebase is already worried about
- which areas could use more testing if you make changes

## Suggested Tracing Exercises

### Trace one admin request from UI to persistence

Try this:

1. Start in `src/ui/app.js` at the flag creation form handler.
2. Follow the request to `POST /api/admin/flags`.
3. Find the matching block in `src/server/router.js`.
4. Follow it into `service.createFlag(...)`.
5. Follow the `store.mutate(...)` call into `src/server/store.js`.

Goal:

- notice where validation, authorization, persistence, and audit logging each happen

### Trace one evaluation request from token to result

Try this:

1. Start at `service.evaluateClient(...)` in `src/server/services.js`.
2. Follow `store.getSnapshot(...)`.
3. Read `compileSnapshot(...)` in `src/core/snapshot.js`.
4. Then read `evaluateSnapshot(...)` and `evaluateFlag(...)` in `src/core/evaluation.js`.

Goal:

- understand how raw stored config turns into a stable runtime decision

### Trace one permission check through the stack

Try this:

1. Find a route that writes data, such as creating a token or strategy.
2. Identify the required scope at the route boundary.
3. Identify the role or project check in `services.js`.
4. Ask what would happen for:
   - a personal admin token
   - a frontend evaluate-only token
   - a project member on the wrong project

Goal:

- separate "scope check" from "role check" in your mind

### Trace one cache invalidation path

Try this:

1. Find a mutation method in `services.js`.
2. Notice it uses `store.mutate(...)`.
3. Read what `mutate(...)` does to `meta.version` and `snapshotCache`.
4. Then inspect `evaluateClient(...)` and the ETag behavior.

Goal:

- connect writes, cache invalidation, snapshots, and stale-read prevention

## Reading Tips For A Junior Dev

- When you see a helper, ask "who calls this?" before studying the implementation deeply.
- When you see a route, ask "is this transport logic or business logic?"
- When you see a state mutation, ask "what invariants must remain true after this?"
- When you see cached data, ask "what invalidates this?"
- When you see a security-related check, ask "what would break if this were missing?"

## A Good First Contribution Strategy

Start with a narrowly scoped change in one of these areas:

- add a test for a missing edge case in `evaluation.js`
- improve an audit event in `services.js`
- add one safer validation to a mutation path
- improve a UI error state in `app.js`

Avoid starting with a cross-cutting redesign until you can comfortably trace at least one admin write and one client evaluation end to end.
