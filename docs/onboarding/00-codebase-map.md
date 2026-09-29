> Historical documentation: this page describes the original implementation. Setup, storage, SDK evaluation, authorization, and the administration UI have changed. Start with the [current CRUD learning course](../../astraupskill/README.md); use this page for before/after comparison.

# Codebase Map

## What Kind Of Application This Is

This repository is a small full-stack feature flag platform. It has:

- a control plane for creating projects, flags, strategies, segments, tokens, and audit records
- an evaluation plane for answering "is this flag enabled for this context?"
- a lightweight admin UI for exploring and mutating the system
- reference SDKs and tests that show how the platform is expected to be used

Even though the app is small, it models patterns that show up in larger systems:

- separate write-time administration from read-time evaluation
- keep domain rules in one place instead of scattering them across routes
- cache compiled state for low-latency reads
- treat auth, token scope, and audit logging as part of the feature, not as extras

## Major Architectural Layers In This Repo

### 1. Core domain and evaluation layer

Main files:

- `src/core/evaluation.js`
- `src/core/snapshot.js`
- `src/core/constants.js`
- `src/core/hash.js`

Responsibility:

- define shared domain concepts such as environment types, flag types, scopes, and resource limits
- compile a "runtime snapshot" for one project/environment
- evaluate flags, constraints, segments, dependencies, rollouts, and variants
- provide deterministic hashing for rollout bucketing and token hashing

Why it matters:

- this is the logic the whole system is protecting
- if these files are wrong, the UI can look correct while the product behaves incorrectly

### 2. Server-side orchestration and business rules

Main files:

- `src/server/services.js`
- `src/server/store.js`
- `src/server/defaults.js`

Responsibility:

- validate writes
- enforce RBAC and token scopes
- append audit entries
- update JSON-backed persistence
- invalidate snapshot cache after mutations
- seed a usable local demo instance

Why it matters:

- this layer is where business rules are centralized
- the route layer is intentionally thin; this is where review attention should go

### 3. HTTP entry and route boundary

Main files:

- `src/server/server.js`
- `src/server/router.js`

Responsibility:

- accept HTTP requests
- route them to service methods
- read JSON bodies and query strings
- serialize success and error responses
- serve the static admin UI

Why it matters:

- this is the boundary where untrusted input becomes internal state
- subtle bugs here often become security bugs, API breakages, or confusing client behavior

### 4. Browser admin UI

Main files:

- `src/ui/index.html`
- `src/ui/app.js`
- `src/ui/styles.css`

Responsibility:

- bootstrap admin data
- let a user switch projects/environments
- create projects, flags, strategies, and tokens
- run playground evaluations
- render dashboard, flags, audit history, and token info

Why it matters:

- this shows the main user workflows end to end
- it also shows how easy it is for state coordination bugs to appear even in a small UI

### 5. Usage examples and tests

Main files:

- `sdk/server-sdk.js`
- `sdk/browser-sdk.js`
- `test/evaluation.test.js`
- `test/services.test.js`

Responsibility:

- show the expected client contract
- lock in important invariants such as deterministic rollout, scope enforcement, and cache invalidation

Why it matters:

- the tests reveal what the codebase currently treats as important behavior
- the SDKs show the intended consumption model more clearly than the UI does

## Major Runtime Boundaries

This repo is small enough that several boundaries live in one process, but they are still conceptually separate.

### UI boundary

- Browser code in `src/ui/*`
- Talks to `/api/admin/*`
- Holds temporary state in memory and `localStorage`

### API boundary

- `src/server/router.js`
- Translates HTTP into service calls and service results into JSON

### Business logic boundary

- `src/server/services.js`
- Owns validation, authorization, audit logging, and coordination logic

### Persistence boundary

- `src/server/store.js`
- Reads/writes `data/state.json`
- Owns snapshot cache invalidation

### Evaluation boundary

- `src/core/snapshot.js` + `src/core/evaluation.js`
- Turns stored configuration into low-latency runtime decisions

### External client boundary

- `sdk/*`
- Represents consumers that do not know the internals, only the API contract

## Important Directories And Their Responsibilities

### `src/core/`

Shared logic that should stay usable by multiple entry points. This is where the core semantics of the feature flag system live.

### `src/server/`

Server-only orchestration. This folder owns I/O, persistence, route dispatch, and permission-sensitive decisions.

### `src/ui/`

The static admin interface. It is intentionally minimal and dependency-light, which makes control flow easier to study.

### `sdk/`

Reference consumers for the evaluation API. Useful for understanding API shape and ETag-based config refresh.

### `test/`

Small but meaningful tests. These are a good place to confirm which invariants the repo considers non-negotiable.

### `data/`

Local JSON persistence. In a production system this would likely become a database or replicated config store.

### `docs/onboarding/`

The onboarding set you are reading now.

## How Data Flows Through The App

### Flow 1: Admin mutation

Example: create a flag from the UI.

1. The browser form in `src/ui/app.js` gathers input and sends `POST /api/admin/flags`.
2. `src/server/router.js` parses the body and forwards it to `service.createFlag(...)`.
3. `src/server/services.js` checks:
   - token scope
   - actor role
   - project membership
   - flag type validity
   - instance-wide key uniqueness
   - whether the target environments are enabled for the project
4. `src/server/store.js` clones the current state, applies the mutation, increments `meta.version`, clears snapshot cache, and persists the new JSON file.
5. The service appends an audit record.
6. Future evaluations see the new flag through a newly compiled snapshot.

### Flow 2: Client evaluation

Example: an app asks whether a flag is enabled.

1. An SDK or client calls `POST /api/client/evaluate` or `POST /api/client/features`.
2. `src/server/router.js` forwards the request to `service.evaluateClient(...)`.
3. `src/server/services.js`:
   - authenticates the token
   - checks `evaluate` scope
   - infers project/environment from token scope
   - loads a cached snapshot from `store.getSnapshot(...)`
4. `src/core/snapshot.js` compiles a per-project/per-environment runtime view if needed.
5. `src/core/evaluation.js` evaluates each flag against context, dependencies, segments, constraints, rollout bucketing, and variants.
6. The service returns a compact result, optionally including debug reasons for trusted clients.

### Flow 3: Playground debugging

Example: an admin wants to understand why a flag did or did not match.

1. The UI posts context to `/api/admin/playground`.
2. The service loads a snapshot for the selected project/environment.
3. `evaluateSnapshot(...)` returns flag results plus reasons and matched strategy info.
4. The UI renders raw JSON so the operator can inspect the decision path.

This flow is useful because it exercises the same evaluation engine as the client API, but with richer visibility.

## Key Concepts And Invariants

These are the most important rules a junior developer should keep in mind.

- Flags belong to projects.
- Project visibility into environments is explicit through a join-like structure, not implied by environment type.
- Flag activation is environment-specific.
- Strategies are scoped by flag and environment.
- Multiple strategies are OR-ed together.
- Strategy ordering matters because the evaluator chooses the first matching strategy when more than one matches.
- Segments are reusable constraint bundles; updating one changes every strategy that references it.
- Dependencies must stay inside the same project.
- Dependency cycles must not be allowed.
- Archived flags evaluate to disabled.
- If a flag has no explicit strategies in an environment, the project/environment default strategy is used.
- Variant weights must sum to 100.
- Gradual rollout and variant assignment are meant to be deterministic for the same stickiness inputs.
- Tokens are hashed at rest.
- Snapshot cache must be invalidated after writes, or evaluators will serve stale config longer than intended.

## Where A Junior Dev Should Be Careful

- Do not add business rules directly in `router.js` just because the input came from HTTP. Prefer keeping those rules in `services.js`.
- Do not change the snapshot shape casually. Evaluation code and caching assumptions depend on it.
- When editing evaluation logic, think about determinism. A rollout that changes for the same user across requests is usually a bug.
- When editing mutations, ask whether the change should append to `auditLogs`.
- When editing token logic, ask whether the plaintext token is exposed only once and whether the stored form stays hashed.
- When editing UI code, remember that the page re-renders manually; there is no framework reconciling state for you.

## Big Picture Risks / Complexity Hotspots

- `src/server/services.js` is the densest file and the main correctness hotspot. It handles authorization, validation, persistence coordination, and audit behavior.
- `src/core/evaluation.js` is small but high-impact. Tiny bugs here can silently mis-ship features.
- The JSON store is simple, but it means mutations rewrite the whole document. That is easy to read, but it would become a scaling and concurrency concern in a real multi-writer system.
- The snapshot boundary is architecturally strong, but easy to weaken. If developers start reading raw state directly during evaluation, latency and consistency assumptions will drift.
- The admin UI is intentionally direct and mutable. That makes it learnable, but it also means state consistency and rendering bugs are easy to introduce.

## Selected High-Leverage Files

For the per-file docs, the most important files selected from this repo are:

- `src/server/server.js`
- `src/server/router.js`
- `src/server/services.js`
- `src/server/store.js`
- `src/core/snapshot.js`
- `src/core/evaluation.js`
- `src/ui/app.js`

These seven files cover the main runtime path from UI event or client request to persistence, cache, and evaluation.
