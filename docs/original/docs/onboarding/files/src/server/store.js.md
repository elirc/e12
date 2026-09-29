# What This File Is For

`src/server/store.js` is the persistence and cache adapter. It hides the details of reading and writing the JSON state file, and it owns the snapshot cache used by the evaluation path.

Type of file:

- persistence adapter
- cache manager
- state container

# Why This File Matters

This file teaches a core systems idea: persistence and caching are correctness concerns, not just storage details.

It matters because:

- every write goes through here indirectly
- snapshot invalidation lives here
- versioning for ETag-based evaluation depends on it

For a junior developer, this file is a good example of why "simple storage" can still be architecturally important.

# Key Exports / Main Units

- `PlatformStore`
  - Main class wrapping JSON persistence, snapshot caching, and in-memory rate limit tracking.

Important methods:

- `init()`
  - Loads persisted state or creates seed state.
- `getState()`
  - Lazy state accessor.
- `persist()`
  - Writes the current state to disk.
- `mutate(mutator)`
  - Clone-update-persist workflow plus version bump and cache invalidation.
- `getSnapshot(projectId, environmentId)`
  - Cached snapshot retrieval and compilation.
- `useRateLimit(key, limit, windowMs)`
  - Small in-memory rate limiter.

# How It Works

## State initialization

On first run:

- create the containing directory
- if the JSON file does not exist, build seed state and persist it

On subsequent runs:

- read the JSON file into memory

## Mutation flow

`mutate(...)` is the key method:

1. clone the current state
2. let the caller mutate the clone
3. bump `meta.version`
4. update `meta.updatedAt`
5. replace in-memory state
6. clear snapshot cache
7. persist to disk

This design is doing more than storage. It is enforcing the rule that every successful write should invalidate cached evaluation snapshots.

## Snapshot flow

`getSnapshot(...)` uses a cache key that includes:

- project ID
- environment ID
- current state version

That means writes naturally make old cached snapshots unreachable once `meta.version` changes.

# How It Connects To Other Files

Inbound relationships:

- Instantiated by `src/server/server.js`
- Used heavily by `src/server/services.js`

Outbound relationships:

- Calls `compileSnapshot(...)` from `src/core/snapshot.js`
- Uses `buildSeedState()` from `src/server/defaults.js`

Important contracts:

- `services.js` should mutate through `store.mutate(...)`, not by editing `store.state` directly.
- `snapshot.js` must be deterministic for a given state/project/environment input.

# Important Design Choices

- JSON file storage instead of a database
  - Great for learnability, limited for concurrency and scale.
- Clone-before-mutate
  - Safer than mutating shared state in place, though still not transactional across processes.
- Cache key includes version
  - Simple invalidation story.
- In-memory rate limits
  - Easy to understand, but not durable or distributed.

Tradeoff:

- Operational simplicity is high, but this approach would not safely handle many concurrent writers.

# Things A Junior Dev Should Notice

- `mutate(...)` is the strongest hidden invariant in the app. Bypassing it would break versioning and cache invalidation.
- The cache stores compiled snapshots, not evaluation results.
- Rate limit state lives only in memory, so restarts reset it.
- `getState()` lazily initializes, which keeps caller code small.

# Code Review Lens

Focus on:

- whether writes still flow through `mutate(...)`
- whether versioning and invalidation happen after every state change
- whether snapshot cache keys still reflect the data they depend on
- whether persistence errors would be surfaced clearly enough

Correctness risks:

- direct mutation of in-memory state
- partial writes that forget to clear cache
- state shape drift breaking snapshot compilation

Maintainability concerns:

- this class quietly owns several responsibilities: persistence, caching, rate limits, and bootstrapping

# Common Change Scenarios

- Replace JSON storage with a database
  - Preserve the `mutate(...)` semantics somewhere, especially versioning and cache invalidation.
- Add another cache
  - Be very explicit about what invalidates it.
- Add more rate-limited operations
  - Inspect how rate-limit keys are generated and whether process-local memory is acceptable.

# Suggested Exercises

- Explain why `meta.version` belongs in the snapshot cache key.
- Identify what would break if a service method wrote `store.state` directly.
- Propose how you would test snapshot invalidation if the code changed.

# Observed Facts vs Inference

Observed from code:

- The store persists JSON to `data/state.json` by default.
- `mutate(...)` increments version and clears `snapshotCache`.
- `getSnapshot(...)` caches compiled snapshots by project, environment, and state version.

Inference / likely intent:

- The store is intentionally simple so the architectural ideas are easy to study.
- The clone-and-swap mutation style is meant to keep write behavior predictable for a learning codebase.
