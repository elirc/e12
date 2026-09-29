# System design follow-ups: now scale it

Each answer starts from what this code does today, cites it, and names the trade-off.

## What exists today

```
  admin browser                 application SDK
        |                              |
        v                              v
 +--------------------------------------------------+
 | node http server  src/server/server.js            |
 |  validateRequest / writeVersion / readJsonBody    |
 |    http-boundary.js:22, :59, :106                 |
 +--------------------------------------------------+
        |                              |
        v                              v
 +-----------------+          +---------------------+
 | services.js     |          | evaluateClient      |
 |  scope, role,   |          |  no state change    |
 |  membership     |          |  router.js:402-412  |
 +-----------------+          +---------------------+
        |                              |
        | store.mutate                 | store.getSnapshot
        v                              v
 +--------------------------------------------------+
 | PlatformStore   storage.js                        |
 |  #withLease (:200) -> re-read -> compare version  |
 |  + sha256 digest (:292) -> clone -> #commit(:228) |
 |  tmp file -> fsync -> renameSync -> #accept       |
 |  snapshot cache keyed [proj, env, version, digest]|
 +--------------------------------------------------+
                        |
                        v
                 data/state.json          (one file = the transaction boundary)
```

## 1. Two people editing the same flag. What happens now, and at 200 editors?

Today: both send `If-Match: "12"`. The second gets 409 from `src/server/storage.js:296-300`, and the UI keeps the draft while showing the latest accepted record. Correct, but the granularity is the whole workspace, so an edit to an unrelated project also conflicts you.

At scale that false-conflict rate becomes intolerable. The move is a per-row `version` column and `UPDATE flags SET ..., version = version + 1 WHERE id = $1 AND version = $2`, checking affected-row count. Trade-off: cross-record invariants that the single-file model got for free, for example the flag-key uniqueness scan in `assertUniqueFlagKey` (`src/server/services.js:249-254`) and the dependency cycle check in `detectDependencyCycle` (`src/server/services.js:354`), now need either a unique constraint or an explicit transaction with the right isolation level. Cycle detection in particular is a read-then-write across many rows, so it needs `SERIALIZABLE` or an advisory lock on the project; per-row versions do not protect it.

## 2. Concurrent writers across processes.

Today a single `wx` lock file is the mutual exclusion: `openSync(this.lockPath, "wx", 0o600)` with `EEXIST` mapped to 503 `Another writer owns the state lease; retry later` (`src/server/storage.js:200-211`). That is a cooperating-writer lease on one machine. It is honest about its limits: a killed writer leaves the lock, and the code refuses to steal it, which `test/storage.test.js:139` enforces.

Scaling means deleting this mechanism rather than improving it. Postgres gives you row locks and transactions; the lease becomes unnecessary. If you must keep file storage, the next step is `flock` advisory locking rather than existence-based locking, because `flock` releases when the process dies and removes the stuck-lease failure mode. Trade-off: `flock` semantics vary across platforms and are weak on network filesystems, so you trade one honest limitation for a subtler one.

## 3. Evaluation at 50,000 requests per second.

Today evaluation is already the cheap path: `getSnapshot` caches compiled per-environment configuration keyed on `[projectId, environmentId, meta.version, digest]` with an LRU cap of 200 entries (`src/server/storage.js:320-338`), and only the context is evaluated per request. There is no database call on the hot path and the routes return `Cache-Control: no-store` (`src/server/router.js:402-412`).

The scaling answer is to stop evaluating server-side. Ship the compiled snapshot to SDKs and evaluate in-process, which is what the rollout design already permits: `bucketValue` is a pure SHA-256 of `${groupId}:${stickinessValue}` (`src/core/hash.js:15-19`, `src/core/evaluation.js:181-182`), so any process computes the same bucket with no shared state. Trade-off: propagation delay. A flag turned off is now off after the poll interval rather than immediately, and you need a kill-switch path that bypasses the cache. You also lose server-side impression metrics unless the SDK batches them back, which is what `POST /api/metrics/impressions` returning 202 (`src/server/router.js:414-423`) is for.

## 4. Multi-tenancy.

Today tenancy is a permission model inside one workspace, not isolation: `canReadProject` and `canWriteProject` (`src/server/services.js:145-175`) gate by instance role plus `projectMembers` rows, and audit reads are filtered by `visibleAudit` (`src/server/services.js:213`). Everything shares one file, one revision counter and one snapshot cache.

For real tenants the first decision is the isolation level. Shared schema with a `tenant_id` column and row-level security is the cheapest and keeps the membership model nearly as written; schema-per-tenant gives stronger blast-radius control and painful migrations; database-per-tenant is the strongest and the most operational work. I would start with shared schema plus RLS, because the authorization checks here already run on every path and RLS turns a missed check into a returned-zero-rows bug instead of a data leak. Trade-off: a single noisy tenant still shares connection pool and cache with the rest, and the workspace-wide revision must become per-tenant or tenants will conflict each other's edits.

## 5. Pagination when a project has a million flags.

Today `filterFlags` (`src/server/services.js:414`) filters an in-memory array and the list endpoints post-filter by `canReadProject`. At a million records the whole document is past the 16 MiB `MAX_STATE_BYTES` cap (`src/server/storage.js:8`) and the app refuses to load it at all, which is the correct failure but not a feature.

In a database, keyset pagination rather than `OFFSET`: order by `(created_at, id)` and pass the last seen tuple as the cursor. Offset pagination at page 5000 scans and discards five million rows, and it silently skips or repeats records when a row is inserted between page fetches. Trade-off: keyset cursors cannot jump to page 500 and are awkward with user-chosen sort columns, so each sort order needs its own index and its own cursor encoding. The second issue is the post-filter: authorization must move into the query predicate, otherwise a page of 50 can return 3 visible rows.

## 6. Background jobs.

There are none today, by design. Every effect is synchronous inside a request, and `mutate` explicitly refuses an async mutator: `if (result && typeof result.then === "function") throw new TypeError("mutator must be synchronous")` (`src/server/storage.js:304-305`). Metrics ingestion returns 202 (`src/server/router.js:418-422`) but is still written inline.

Work that wants to be a job: metrics retention cleanup, which `astraupskill/VERIFICATION.md` lists as absent; expiring stale tokens; recomputing snapshots. The pattern I would use is a transactional outbox rather than enqueueing from the request: write the job row in the same transaction as the state change, and have a worker poll it. Trade-off: outbox adds a table, a poller and at-least-once delivery, so every consumer must be idempotent. Firing a queue message after the commit is simpler and loses messages exactly when the process dies, which is the moment you most wanted the message.

## 7. Authentication and secret handling at scale.

Today tokens are opaque bearer strings, stored only as `stableHash("token:" + token)` (`src/core/hash.js:3-9`), matched in `getActorFromToken` (`src/server/services.js:56`), with plaintext shown exactly once and unrecoverable afterwards, as `astraupskill/VERIFICATION.md` states. Scope, instance role and project membership are three separate checks (`src/server/services.js:115-175`), which is the part worth keeping.

Scaling adds two things: rotation without downtime, meaning a token can have overlapping validity windows and a `lastUsedAt` so you can prove nothing still uses the old one; and a real hash choice. SHA-256 is right for a high-entropy random token and wrong for anything user-chosen, so the moment human passwords enter the system this becomes Argon2id. For the admin UI specifically I would move from bearer tokens to short-lived sessions, because a bearer token in browser storage is a persistent exfiltration target. Trade-off: sessions need a revocation store and therefore a lookup the stateless token avoided.

## 8. Observability.

Today: a `X-Request-Id` per response (`src/server/http-boundary.js:10-11`), an append-only `auditLogs` collection through `appendAudit` (`src/server/services.js:225`), and an in-memory rate limiter with a 10000-key ceiling (`src/server/storage.js:340-362`). No metrics, no traces, and the request id is generated but not correlated to anything downstream.

The first three things I would add, in order of payoff: structured request logs carrying that same request id plus actor, route, status and duration, so a 409 spike is attributable to a specific client; a counter on evaluation outcomes broken down by flag key and reason, since `matchGradualRollout` already returns a human reason string (`src/core/evaluation.js:183-190`) and those reasons are the highest-signal debugging data in the system; and a gauge on lease wait time, because 503 from `#withLease` is the canary for write contention. Trade-off: flag key as a metric label is unbounded cardinality if anyone creates flags programmatically, so it needs a cap and an "other" bucket.

## 9. Migrating this to the target stack.

To ASP.NET Core: `If-Match` maps to the same header, `meta.version` becomes a per-row `rowversion`, the lease is replaced by an EF Core transaction, and a `DbUpdateConcurrencyException` translates to 409. To Express or Nest on Postgres: the same, with the version column in the `WHERE` clause. Either way the evaluation core (`src/core/evaluation.js`, `src/core/hash.js`, `src/core/snapshot.js`) ports nearly unchanged, because it is pure functions over a snapshot with no I/O. That separation is what I would keep; the JSON store is what I would throw away.
