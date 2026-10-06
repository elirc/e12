# Concepts behind reliable administration CRUD

Each concept below is shown through this repository's own code. Line numbers were checked on 2026-10-06.

## Identity, scope, and membership answer different questions

Authentication asks which persisted token and user a request represents. `getActorFromToken` (`src/server/services.js:56-71`) hashes the bearer string and finds an unrevoked token with that hash. A token **scope** limits the *kind* of operation. **Project membership** decides *where* the user may perform it. The write check needs both:

```js
// src/server/services.js:187-195
function requireProjectWrite(state, actor, projectId) {
  requireScope(actor, "write");
  assert(getProject(state, projectId), 404, "Project not found");
  assert(
    canWriteProject(state, actor, projectId),
    403,
    "Project write access denied",
  );
}
```

`canWriteProject` (158-175) answers true for an `instance_admin`. Anyone else needs an instance role of `project_owner` or `project_member` *and* a `projectMembers` row with one of those roles for this project. So a `write` token held by a member of Checkout cannot edit another project's flags. A legacy token that happens to contain `admin` still cannot create projects, because `requireInstanceAdmin` (135-143) also checks the user's role. The effective permission is the intersection of scope, role and membership.

The wrapper at 2017-2027 re-reads the token from the current state on every call. If a token is revoked between two requests, the next call fails with 401 even though the caller still holds an `actor` object from earlier. Browser controls explain permissions to the user. The server enforces them independently.

## PATCH omission differs from false and empty

Suppose the accepted record is `{description: "Old text", stale: true}`. A PATCH `{description: ""}` intentionally clears the description and leaves `stale` alone. A PATCH `{stale: false}` intentionally unmarks it. Here is how `updateFlag` keeps those apart:

```js
// src/server/services.js:927-933 (indentation reduced)
if (input.name) target.name = input.name;
if (input.description !== undefined)
  target.description = input.description;
if (input.type) target.type = input.type;
if (input.stale !== undefined) target.stale = Boolean(input.stale);
if (input.archived !== undefined)
  target.archived = Boolean(input.archived);
```

`description` and the booleans use `!== undefined`, so `""` and `false` are real values. `name` and `type` use truthiness, which is safe only because the contract already refuses an empty name (`text(100)` requires 1..100 characters, `src/server/contracts.js:27-28`). On the browser side, `changes()` (`src/ui/app.js:680-689`) sends only fields that differ from the loaded baseline. It never fills omitted fields with form defaults, which could overwrite another editor's accepted value.

## Validation has layers, and each layer has a status code

| Layer | Example rule | Status | Where |
|---|---|---|---|
| HTTP boundary | body over 64 KiB, `__proto__` key | 413 / 422 | `src/server/http-boundary.js:106-167`, `77-104` |
| Precondition | missing or malformed `If-Match` | 428 | `http-boundary.js:59-75` |
| Contract | unknown field, wrong type, rollout outside 0..100 | 422 | `src/server/contracts.js:85-97`, `56-60` |
| Service | missing project, no membership, missing confirmation | 404 / 403 / 409 | `services.js:187-195`, `271-286` |
| Storage | duplicate record id, non-finite number, file over 16 MiB | 422 | `src/server/storage.js:67-111`, `234-238` |

An integer weight of 60 is valid on its own. Two sibling weights of 60 break the rule that variants sum to 100, and no single-field check can see that. The rule appears twice: once in the contract (`contracts.js:253-257`, status 422) and once in the service (`assertVariantWeights`, `services.js:312-339`, where a bad sum is **400** and a duplicate name is **409**). Practice exercise 4 makes you observe that inconsistency.

## Optimistic concurrency protects edits

The workspace has one global revision, `meta.version`. An editor loads revision 8 and sends `If-Match: "8"` when saving. The comparison happens under the lease:

```js
// src/server/storage.js:290-301 (indentation reduced)
const current = this.#read();
const expectedDigest = request?.digest ?? this.#digest;
if (
  current.state.meta.version !== expectedVersion ||
  (expectedDigest !== null && current.digest !== expectedDigest)
) {
  this.#accept(current);
  throw storageError(
    409,
    "State changed; reload and review before saving",
  );
}
```

This also makes the service's *check-then-act* code safe. `updateFlag` runs its permission and confirmation checks against the request's frozen snapshot (from `runRequest`, `storage.js:184-192`), not against the draft. If someone else committed in between, the version or digest no longer matches and the whole operation is refused. The checks never run against data that changed after they passed.

Global revisioning is simple, but two editors changing unrelated records still conflict. Recognize that trade-off before you propose per-record versions (practice exercise 11). Per-record versions make operations that span projects, mappings, strategies and audit entries harder.

A conflict is different from an uncertain response. After a network failure the server may already have accepted the request. The UI marks such writes `uncertain` (`src/ui/app.js:180-188`) and blocks further saves until the user reviews the latest state. The app has no durable request receipts, so retrying a POST could create a second record. One-time token plaintext is especially sensitive: only its hash is stored, so a lost creation response cannot be recovered.

## Durability and visibility are separate events

`#commit` (`storage.js:228-260`) publishes the new state in memory only after `renameSync` has succeeded (line 249, then `#accept` at 252). If memory were published first, readers could see a change that a disk failure later rolled back. The writer lease (`#withLease`, 200-226) is a lock file opened with the `wx` flag. A second writer gets `EEXIST`, which becomes 503. The lease is never waited on or stolen. The digest catches external edits even when nobody advanced the revision (test: `test/storage.test.js:124`). These mechanisms suit local learning. They are not a distributed transaction and do not survive every power-loss scenario.

## Cache configuration, evaluate context

The snapshot cache key is `[projectId, environmentId, meta.version, digest]` (`storage.js:323-328`). It names the configuration that was used. It says nothing about which user asked. In the seed data, `checkout_redesign` in production has a 25% gradual rollout behind the "Beta users" segment (`plan` in `pro`, `enterprise`). Evaluated against the same snapshot, whose ETag is `W/"checkout-production-1"` on a fresh seed:

| context | enabled | reason |
|---|---|---|
| `{userId: "d", plan: "pro"}` | true (variant `treatment`) | Within gradual rollout bucket |
| `{userId: "a", plan: "pro"}` | false | Bucket 70 > 25 |
| `{userId: "d", plan: "free"}` | false | Constraint mismatch: plan in pro,enterprise |
| `{plan: "pro"}` | false | Missing stickiness field "userId" |

These rows come from running `compileSnapshot` and `evaluateSnapshot` on `buildSeedState()` (07-TRACE-LAB Lab D has the script). One ETag maps to four different answers. A 304 response keyed on the ETag would therefore give user A user D's decision. That is the defect fixed in 03-WORKED-CHANGE §4.

Bucketing is deterministic: `bucketValue` (`src/core/hash.js:15-19`) hashes `"<groupId>:<userId>"` with SHA-256, takes the first 12 hex digits, and maps them to 1..100. The same user always lands in the same bucket, and nothing is stored. Variant selection uses a *different* hash input, `"variant:<flagKey>:<userId>"` (`evaluation.js:231-234`). Being inside the rollout therefore does not bias which variant you get. A missing or non-scalar context value never matches, even through `not_in` or `inversion` (`evaluation.js:54-56`). Missing data cannot switch a flag on.

## Delete policy communicates ownership

Owned variants disappear with their strategy. A referenced segment cannot disappear while a strategy needs it. A flag must be archived before it can be deleted, and it still cannot be deleted while metrics or dependencies reference it (`services.js:1893-1911`). These policies protect meaning, not just consistency. Before you add any DELETE route, write down which records are owned, which are shared, which history must survive, and what the user sees when deletion is refused. The deletion table in 01-CODEBASE-MAP lists the current rules with line numbers.
