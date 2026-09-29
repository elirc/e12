# Flashcards: feature flag platform

Thirty-six pairs. Cover the right column, answer aloud, then check. Ten minutes a day.

| Question | Answer |
|---|---|
| Which header carries the reviewed workspace revision on an admin write? | `If-Match`, read by `writeVersion` in `src/server/http-boundary.js:59` |
| Status code when `If-Match` is absent on an admin write? | 428, message `Supply the reviewed workspace version as If-Match: "1"` |
| Status code when the named revision is no longer current? | 409, `State changed; reload and review before saving` (`storage.js:296-300`) |
| Which admin route is exempt from the precondition, and why? | `/api/admin/playground`; it evaluates a hypothetical context and mutates nothing |
| Regex the ETag value must match | `/^"[1-9][0-9]{0,15}"$/` - quoted, no leading zero, at most 16 digits |
| Name of the method that takes the exclusive writer lease | `#withLease`, `src/server/storage.js:200` |
| Open flag used to create the lock file | `"wx"`, so creation fails with `EEXIST` if the lock already exists |
| Status code returned when another writer holds the lease | 503, `Another writer owns the state lease; retry later` |
| Does the app ever steal a stale lease? | No. Test `existing writer lease is never stolen or removed`, `test/storage.test.js:139` |
| Two-part precondition checked inside `mutate` | `meta.version` equality **and** SHA-256 digest equality (`storage.js:292-295`) |
| Why check the digest as well as the version? | An external edit can keep the same version; bytes catch it. Test at `test/storage.test.js:124` |
| The four writes of `#commit`, in order | serialize, open `.tmp` sibling `wx`, write + fsync + close, `renameSync`, then `#accept` |
| Why is the temp file a sibling of the target? | Rename is atomic only within one filesystem |
| What does `#accept` receive as its state? | `JSON.parse` of the exact bytes just written, not the draft (`storage.js:252-255`) |
| Invariant sentence for the persistence fix | A successful mutation publishes the same representation to readers and disk; a failed pre-replacement mutation preserves the previous file |
| Test that proves the failed-write case | `failed replacement preserves accepted disk and memory state and cleans temporary files`, `test/storage.test.js:60` |
| How is the rename failure injected? | An `fsImpl` object passed to the `PlatformStore` constructor (`storage.js:120-127`) |
| Does `mutate` accept an async mutator? | No. `TypeError("mutator must be synchronous")`, `storage.js:304-305` |
| `MAX_STATE_BYTES` | 16 MiB, `src/server/storage.js:8` |
| `MAX_BODY_BYTES` | 65536, `src/server/http-boundary.js:4`, checked against declared and streamed length |
| Status for a body over the cap | 413, `Request body exceeds 64 KiB` |
| Three field names rejected in JSON bodies | `__proto__`, `constructor`, `prototype`, 422 `Unsupported JSON field name` |
| JSON limits enforced by `inspect` | depth 10, string 20000 chars, array 2000 items, object 1000 fields |
| Status when a write arrives with a cross-site `Sec-Fetch-Site` | 403, `Cross-site writes are not allowed` |
| How many collections does `validateState` check? | 19, listed in `COLLECTIONS` at `storage.js:12-32` |
| What does `validateState` deliberately **not** check? | Relationships and authorization; shape and identity only (comment at `storage.js:108-110`) |
| Three independent authorization questions | token scope, instance role, project membership |
| Function that checks token scope | `requireScope`, 403 `Token is missing "<scope>" scope`, `services.js:115` |
| Roles that can write a project via membership | `project_owner` and `project_member` (`canWriteProject`, `services.js:165-174`) |
| Which role short-circuits `canWriteProject` to true? | `instance_admin` |
| How are API tokens stored? | Only as `stableHash("token:" + token)` via `hashToken`, `src/core/hash.js:7-9` |
| Exact confirmation string for a protected environment | `CONFIRM:<environment.key>`, else 409 (`services.js:271-286`) |
| Four checks in `assertVariantWeights` and their codes | integer 0-100 -> 422; unique names -> 409; single stickiness field -> 422; total exactly 100 -> 400 |
| Default stickiness field for a gradual rollout | `userId` (`src/core/evaluation.js:171`) |
| String hashed for a rollout bucket | `` `${groupId}:${stickinessValue}` ``, `groupId` defaults to the flag key |
| Range returned by `bucketValue` | 1 to 100 inclusive, `(numeric % range) + 1`, `src/core/hash.js:18` |
| What happens when the stickiness field is missing? | `matched: false` with reason `Missing stickiness field "userId"`; it fails closed |
| Key of the compiled snapshot cache | `[projectId, environmentId, meta.version, digest]`, capped at 200 entries |
| Why was the evaluation 304 path removed? | Configuration identity is not result identity; the user context was missing from the key |
| Two regression tests for the context bug | `test/context-cache.test.js:23` and `:44` (debug mode) |
| Status and cache header on `POST /api/client/evaluate` | 200 with `Cache-Control: no-store`, `router.js:402-405` |
| Status returned by metrics ingestion | 202, `router.js:418-422` |
| Command for the whole backend suite | `npm test`, which runs `node verification/run-tests.js` |
| Command for one focused file | `node --test test/storage.test.js` |
| Verified counts to quote in an interview | 98 backend tests, 20 Chromium workflows in 92.54 seconds |
| Three limits to state unprompted | not a distributed store; a killed writer can leave a lease; no durable idempotency receipts |
| Why not auto-retry a 409 with the newest revision? | It turns optimistic concurrency into last-write-wins and makes the precondition meaningless |
