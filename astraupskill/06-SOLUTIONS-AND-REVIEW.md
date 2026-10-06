# Solutions and senior review

Use this chapter after your own attempt at [the practice exercises](05-PRACTICE.md). The first part gives the reasoning behind each exercise, plus the minimal diff where one exists. The minimal diffs for exercises 3 and 7 were applied to a scratch copy on 2026-10-06. Each made its harness pass while the original 98 tests stayed green. The second part is a code review of the repository as it stands, written the way a senior reviewer would: a claim, evidence by file and line, and a recommendation.

## Part 1: exercise notes

### 1-2. Bucketing and missing data

The range is 1..100 because `bucketValue` returns `(numeric % range) + 1` (`src/core/hash.js:18`). With `matched: bucket <= rollout`, rollout 0 then enables nobody and rollout 100 enables everybody. With a 0..99 range, `<=` would let bucket 0 through at rollout 0. The boundary test you added in exercise 1 is the important lesson: 200 random users never hit bucket 100, so only a test built on `bucketValue` itself catches an off-by-one.

For exercise 2, the real flag at risk is in the seed. The production strategy for `checkout_redesign` attaches the "Beta users" segment, `plan in [pro, enterprise]`. Rewrite it with `not_in [free]` and remove line 56, and every context *without* a `plan` field would pass the constraint and go on to the rollout check. The comment on `evaluation.js:55` states the invariant: missing or invalid data must not become an enabled result through negation.

### 3. Validation message prefix

The minimal change touches two lines in `src/server/contracts.js`:

```diff
-      reject(field, "gradual rollout requires a rollout percentage");
+      reject(`${field}.parameters.rollout`, "gradual rollout requires a rollout percentage");
...
-  if (method === "createStrategy") validateStrategySettings(result);
+  if (method === "createStrategy") validateStrategySettings(result, "body");
```

Check the type before the range. `integer(100)` (`contracts.js:56-60`) uses `Number.isInteger`, so `"25"` is rejected rather than coerced, and the harness pins that. Never build an error by echoing the whole incoming body: it could contain a token or 64 KiB of junk. `updateStrategy` (`services.js:1158`) still calls `validateStrategySettings` with the default `"strategy"` prefix. A thorough solution changes that call too, or explains why it is left alone.

### 4. Variant bookkeeping

A defensible answer to (a): use 422 for every semantic validation failure, including bad sums and duplicate names, and keep 409 for state conflicts (a stale version, or a reference that blocks a delete). Today the same rule answers 422 in the contract (`contracts.js:253-257`), 400 for a bad sum (`services.js:338`) and 409 for a duplicate name (`services.js:326-330`). A client cannot tell a retryable conflict from a malformed request by the status alone.

For (b): per-variant create and delete can only succeed for weight-0 variants or a single 100-weight variant, because every intermediate state must already sum to 100 (`assertSiblingVariantWeights`, 341-352, and the delete check, 1933-1939). The usable path is to replace the whole set through `updateStrategy`, which regenerates variant ids (1199-1218). Either remove the per-variant endpoints or accept a set operation there too. Variant *names* are what reach the metrics (`variantName`, `contracts.js:383`), so id churn does not break impression history. It does break any external link to a variant id.

### 5. Two writers

The digest half of the condition (`storage.js:294`) catches an edit made *without* bumping the version, such as someone hand-editing `data/state.json` in an editor. If the version were the only check, the next mutation would accept the stale draft and overwrite that external edit without anyone noticing. `test/storage.test.js:124` covers it.

### 6. Browser race

The `clear()` follow-up passes without any code change, because `clear()` increments `#sequence` (`sdk/browser-sdk.js:52`) and the pending refresh then fails the equality check on line 43. If your new test fails, check that you awaited the pending refresh *after* resolving it.

### 7. Authorize first

```diff
       assert(strategy, 404, "Strategy not found");
-      validateStrategySettings({ ...strategy, ...input });
       const flag = getFlag(state, strategy.flagId);
       requireProjectWrite(state, actor, flag.projectId);
+      validateStrategySettings({ ...strategy, ...input });
```

The 404 on line 1157 still comes before the 403. That leaks whether a strategy id exists, but ids are 12 random hex characters (`createId`, `src/core/hash.js:11-13`), so the leak is accepted here. The leak you removed was worse. The 422 message was derived from the *stored* record ("only gradual rollout accepts parameters" tells an outsider that the strategy is not a gradual rollout). Apply the same move in `updateVariant`: `validateVariant` (1288) should come after `requireProjectWrite` (1299).

### 8. Archive filter

Represent the filter as one explicit value (`active`, `archived` or `all`). Apply it to the already-authorized list before computing `maxPage`. The clamp `state.page = Math.min(state.page, maxPage)` already exists at `src/ui/app.js:931`, so reuse it rather than writing a second reset. Keep `state.editor` independent of the list. A good browser assertion starts on page 2, switches to a single-result filter, expects "Page 1 of 1 · 1 records" in `#page-label` (`app.js:968-969`), and checks that no write request was sent.

### 9. Key scope

Both answers are defensible. Global keys keep audit and metrics unambiguous, but the 409 text (`services.js:253`) reveals another project's key to anyone who can create flags. Per-project keys match how SDKs already resolve flags (one project per token, `services.js:1648`) and remove the oracle. However, every place that looks a flag up by key alone must then also take the project. A solution that changes `assertUniqueFlagKey` without auditing the callers at 847 and 924 is incomplete.

### 10-13. Design exercises

- **Delete refusal (10).** Authorize every identifier before returning it. Keep the generic 409 for details the actor cannot see. Do not remove the service guard just because the UI now warns first: another API caller can skip the warning.
- **Per-record versions (11).** The strongest answer names the invariants that currently ride on the global revision: segment existence for strategies (`assertSegmentsBelongToProject`, `services.js:300-310`), dependency acyclicity (`detectDependencyCycle`, 354-385), and resource limits (for example the flag count at 848-853). For each one, it says which database mechanism replaces it.
- **Receipts (12).** Look up `(actor, operation, requestId)` inside the same `mutate` that creates the flag. Compare a canonical payload fingerprint. Return the earlier identity for a matching replay, and reject a mismatched reuse. For tokens, storing plaintext in order to replay it changes the security model. Return the token id instead, and require revoke-and-reissue when the secret is lost.
- **Migration (13).** Use explicit foreign keys for ownership (`ON DELETE CASCADE` for variants under a strategy) and for references (`RESTRICT` for segments referenced by strategies). Write each mutation and its audit row in one transaction. Protected-environment confirmation stays in the application.

## Part 2: senior review of the current code

Findings are ordered by how much they matter to a user. Each one was checked against the source on 2026-10-06.

| # | Finding | Evidence | Recommendation |
|---|---|---|---|
| R1 | Validation against stored data runs before the project-write check, so a 422 can describe a strategy or variant to a non-member. | `services.js:1158` vs `1160`; `1288` vs `1299`; reproduced by exercise 7 | Authorize first (exercise 7 diff). |
| R2 | Flag keys are unique across all projects, and the 409 message names the key. | `services.js:249-254`, called at `847` and `924`; exercise 9 | Decide the scope explicitly. If keys stay global, make the message generic. |
| R3 | The variant-weight rule answers 422, 400 or 409 depending on which layer catches it. | `contracts.js:253-257`; `services.js:324`, `330`, `338`; exercise 4 | Standardize semantic failures on 422. |
| R4 | Per-variant create and delete are effectively unusable for splits, because every intermediate state must sum to 100. | `services.js:341-352`, `1933-1939`; exercise 4 | Expose set replacement only, or validate the final set. |
| R5 | `#withLease` closes the handle before unlinking the lock file. If `closeSync` throws, the lease is stranded until someone recovers it by hand. | `storage.js:222-225` | Unlink in its own `try`, or unlink before close, and test with an `fsImpl` whose `closeSync` throws. |
| R6 | Error `details` are collected but never serialized, so structured errors cannot reach the client. | `services.js:21-26`; `router.js:440-445` | Serialize an allow-listed `details` object when you implement exercise 10. |
| R7 | `STRATEGY_TYPES` lists `custom`, but the contract accepts only three types. The "Unknown custom strategy" branch in evaluation runs only for a hand-edited state file. | `src/core/constants.js:16-21`; `contracts.js:184`; `evaluation.js:302-307` | Remove `custom` from the constant, or document it as reserved. |
| R8 | The snapshot cache evicts the oldest *inserted* entry. A cache hit does not refresh an entry. | `storage.js:329-331` | Fine at 200 entries. If this grows, delete and re-insert on hit to get true LRU. |

Things a reviewer should *not* flag, because they are deliberate and tested:

- **The per-request token re-read in the wrapper** (`services.js:2017-2027`). It costs one scan but makes revocation effective mid-session.
- **Reading the request body before capturing state** (`server.js:41-44`).
- **Refusing to steal a lease** (`test/storage.test.js:139`).
- **Re-evaluating every context instead of answering 304** (`test/context-cache.test.js:23`).

## Writing the review

Lead with the concrete problem and the resulting behavior. Then give the narrow implementation choice, the tests that prove it, and the limits that remain. For example: "A non-member editing a strategy now always receives 403. Previously a malformed body returned a 422 derived from the stored strategy. Verified by `test/practice-07-authorize-first.test.js` and the existing 98 cases. `updateVariant` has the same ordering and is fixed in the same change." Do not claim complete reliability from one passing screenshot. Part of mid-level judgment is deciding what evidence is sufficient and naming what it does not cover.
