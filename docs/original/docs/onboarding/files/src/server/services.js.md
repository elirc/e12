# What This File Is For

`src/server/services.js` is the main business logic layer of the application. It owns most of the rules that make this product a feature flag platform rather than just a JSON CRUD server.

Type of file:

- domain service layer
- orchestration layer
- policy enforcement layer

# Why This File Matters

This is the single most important file to study in the repo.

It teaches:

- where authorization should live
- how to centralize invariants
- how to keep routes thin
- how to coordinate persistence, caching, and audit logging
- how easy it is for a "service" file to become the main correctness hotspot

If you can read this file well, you can usually debug or review most changes in the codebase.

# Key Exports / Main Units

- `createPlatformService(store)`
  - Factory that returns the service API used by routes.

Important internal helpers:

- `createError(...)` and `assert(...)`
  - Give the file a consistent failure style.
- `getActorFromToken(...)`
  - Authenticates a bearer token against stored hashed tokens.
- `requireScope(...)`
  - Enforces coarse token-level permissions.
- `requireAdminRole(...)`
  - Enforces that some actions require a human admin token, not just any token with scope.
- `requireProjectRead(...)` / `requireProjectWrite(...)`
  - Enforce project-level authorization.
- `appendAudit(...)`
  - Central audit writer.
- `detectDependencyCycle(...)`
  - Prevents invalid same-project dependency graphs.
- `serializeFlag(...)`
  - Builds richer flag objects for callers.

Important service methods:

- project methods: `listProjects`, `createProject`, `updateProject`
- environment methods: `listEnvironments`, `createEnvironment`
- flag methods: `listFlags`, `createFlag`, `updateFlag`, `changeFlagLifecycle`
- segment/strategy/variant/dependency methods
- token methods: `listTokens`, `createToken`, `revokeToken`
- read-side helpers: `getDashboard`, `playground`, `evaluateClient`, `summarizeMetrics`

# How It Works

The file follows a recognizable pattern:

1. authenticate and authorize
2. validate invariants
3. perform a mutation or read
4. attach audit information when needed
5. return a caller-friendly shape

## Authorization model

There are at least three layers of access control here:

- bearer token must exist
- token must have the required scope
- actor must also have the right human role or project membership for many admin paths

That distinction matters. A machine token may have `evaluate` scope but still be forbidden from admin routes because it is not backed by a user.

## Mutation model

Most writes use `store.mutate(...)`, which means:

- the service provides a mutator callback
- the store clones state, runs the callback, bumps version, clears cache, and persists

This keeps versioning and cache invalidation consistent.

## Data integrity checks

Examples of important checks:

- flag keys must be unique instance-wide
- a project must keep at least one environment
- flags can only target environments enabled for the project
- dependencies must stay in one project and must not introduce cycles
- protected environments require explicit confirmation
- variant weights must sum to 100

## Evaluation path

`evaluateClient(...)` is especially important because it bridges the admin model and the runtime model:

1. authenticate token
2. require `evaluate` scope
3. infer scoped project/environment from the token
4. load a cached snapshot from the store
5. optionally short-circuit on ETag
6. evaluate the snapshot against client context

# How It Connects To Other Files

Inbound relationships:

- Called by nearly every route in `src/server/router.js`

Outbound relationships:

- Uses `evaluateSnapshot(...)` from `src/core/evaluation.js`
- Relies on `PlatformStore` from `src/server/store.js`
- Uses `createId(...)` and `hashToken(...)` from `src/core/hash.js`
- Relies on enums and defaults from `src/core/constants.js`

Important contracts:

- The store must invalidate snapshots after any mutation.
- The snapshot/evaluation layer must accept the shapes this file constructs and persists.
- The UI and SDKs depend on response shapes this file returns through routes.

# Important Design Choices

- Service factory rather than a class hierarchy
  - Simple and direct for a small codebase.
- Throwing structured errors instead of returning result unions
  - Keeps happy paths readable, but makes good route-level error handling mandatory.
- Manual validation instead of a schema library
  - Easy to read, but easier to miss edge cases.
- Auditing embedded in mutation paths
  - Good for consistency, but easy to forget when adding new writes.

Tradeoffs:

- Simplicity and explicitness are high.
- The file is becoming large, so the risk of "god object" behavior is real.

# Things A Junior Dev Should Notice

- `requireScope(...)` and `requireAdminRole(...)` are not interchangeable.
- Some methods enforce both instance-wide and project-local rules.
- `serializeFlag(...)` creates a richer read shape than the normalized stored shape.
- `evaluateClient(...)` deliberately suppresses debug reasons for frontend tokens.
- Resource limits are enforced at write time, not at route definition time.
- The file uses stored IDs heavily; any change to ID relationships has broad impact.

# Code Review Lens

Focus on:

- missing or inconsistent invariant checks
- authorization gaps between similar methods
- whether every sensitive mutation is audited
- whether the mutation leaves related collections in sync
- whether a new rule belongs here or in the evaluator/store instead

Edge cases to challenge:

- omitted optional fields
- wrong project, right token scope
- production confirmation missing
- dependency graph corner cases
- malformed or partial variants

Maintainability concerns:

- repeated patterns that may drift out of sync
- response shapes becoming inconsistent across methods
- helper functions that encode policy implicitly without clear naming

# Common Change Scenarios

- Add a new strategy type
  - Inspect `createStrategy`, `updateStrategy`, `src/core/evaluation.js`, `src/core/constants.js`, and tests.
- Tighten token security
  - Inspect token creation, token listing, `getActorFromToken`, route scopes, and both SDKs.
- Add a new flag lifecycle rule
  - Inspect flag creation/update methods, dashboard aggregation, evaluation behavior, and audit expectations.
- Refactor project authorization
  - Inspect every place `requireProjectRead(...)` and `requireProjectWrite(...)` are used before changing shared helpers.

# Suggested Exercises

- Trace exactly how `createFlag(...)` enforces project/environment invariants.
- Compare `evaluateClient(...)` with `playground(...)` and explain why their debug behavior differs.
- Find one mutation path and verify whether it always writes an audit record.
- Propose one small refactor that would reduce file size without scattering policy across layers.

# Observed Facts vs Inference

Observed from code:

- This file performs authentication, authorization, validation, mutation coordination, and some read aggregation.
- It is the primary caller of `store.mutate(...)`.
- It contains explicit checks for token scopes, project membership, dependency cycles, protected environments, and variant weight totals.

Inference / likely intent:

- The author wants business rules centralized in one layer instead of split across routes and core helpers.
- The current size suggests a likely future refactor into narrower service modules if the app grows.
