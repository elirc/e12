# Stories and resume material: feature flag platform

## STAR story 1: the write that was accepted in memory but not on disk

**Situation.** The original store applied a mutation to in-memory state, cleared its snapshot cache and then wrote the JSON workspace file. A failing write left the process serving a project name that the file did not contain, or a file that was half-written.

**Task.** Define what "accepted write" means in this system and make every path obey it, rather than adding error handling around the symptom.

**Action.** I wrote the invariant first: a successful mutation publishes the same accepted representation to readers and to disk, and a failed pre-replacement mutation preserves the previous accepted file. Then I rebuilt the commit path in `src/server/storage.js` to a fixed sequence: take an exclusive writer lease (`#withLease`, line 200), re-read and compare both revision and SHA-256 digest (lines 290-301), clone and mutate a private draft, validate and serialize under the 16 MiB cap, write a uniquely named sibling temp file, fsync, close, `renameSync` over the target, and publish only after the rename returns (`#commit`, lines 228-260).

**Result.** `test/storage.test.js:60`, "failed replacement preserves accepted disk and memory state and cleans temporary files", injects a throwing `renameSync` through the store's `fsImpl` seam and asserts the file bytes are unchanged, memory still holds the old value, and no operation-owned temp file remains. The full backend suite is 98 passing cases.

## STAR story 2: two users, one answer

**Situation.** Evaluation responses were sometimes correct for the previous caller rather than the current one. The server SDK kept a single ETag with a single result array and the service compared configuration identity before reading the submitted user context.

**Task.** Find the real key, not a bigger cache.

**Action.** I named the five distinct pieces of state people were calling "the cache": the accepted file, the editable draft, the compiled configuration snapshot, one context's evaluation result, and the flags currently published to the browser. Each has a different owner and a different condition for being current. Only the per-context result was keyed on an identity that excluded its own input. I kept the compiled-snapshot cache (`getSnapshot`, `src/server/storage.js:320-338`), removed the conditional request header from the server SDK, and made the evaluation routes always answer 200 with `Cache-Control: no-store` (`src/server/router.js:402-412`).

**Result.** Two regressions lock the behavior: `test/context-cache.test.js:23` proves a pro user and a free user get different results under an unchanged snapshot ETag, and `test/context-cache.test.js:44` proves a debug-mode change alters the response even when configuration has not.

## STAR story 3: ordering in the browser, not in the server

**Situation.** Even with fresh server evaluation, the browser could publish a stale result: request A starts, request B starts, B finishes, A finishes last and overwrites B.

**Task.** Make sure only the latest requested context is allowed to publish shared browser state, without adding sleeps to the tests.

**Action.** The browser SDK assigns each request a sequence number; every caller still receives its own promise result, but only the newest sequence may publish. `clear()` stops an outstanding request from republishing after sign-out, and returned maps are copies so one subscriber cannot mutate another's view.

**Result.** `test/sdk.test.js` controls promise completion order explicitly rather than depending on timing, and the 20-workflow Chromium run passed in 92.54 seconds with no uncaught browser JavaScript errors recorded in `astraupskill/VERIFICATION.md`.

## Resume bullets

- Rebuilt the persistence boundary of a Node 22 feature flag platform around an exclusive writer lease, a revision-plus-digest precondition and atomic temp-file rename, eliminating a class of defect where in-memory state diverged from the accepted file on a failed write.
- Diagnosed and fixed an evaluation cache keyed on configuration identity rather than user context, which returned one user's flag decision to another; kept snapshot caching and added two regression tests that fail on the old behavior.
- Added HTTP-level optimistic concurrency with `If-Match`, returning 428 when the precondition is absent and 409 when the reviewed workspace revision is stale, with the client keeping its draft instead of auto-resubmitting.
- Hardened the request boundary with a 64 KiB body cap checked against both declared and streamed length, JSON depth, array and field limits, rejection of prototype-poisoning field names, and same-origin write enforcement.
- Verified the result with 98 backend tests on Node's built-in runner, no runtime dependencies, plus 20 real Chromium workflows completing in 92.54 seconds against an isolated synthetic dataset.

## 60-second spoken summary

"It is a feature flag platform: administrators configure projects, environments, flags, segments and percentage rollouts, and applications post a user context and get a decision back. Plain Node 22, no runtime packages, one JSON document as the workspace.

The interesting work was two defects. The first was persistence: the old code updated memory and then wrote the file, so a failed write left the server serving something the file did not contain. I replaced that with a lease, a revision and digest check, a temp file next to the target, and an atomic rename, publishing to readers only after the rename succeeds. The test injects a throwing rename and asserts the original bytes survive.

The second was evaluation. A cache was keyed on configuration identity, so a second user could receive the first user's answer. The fix separated configuration identity from result identity: keep the compiled snapshot cached, evaluate every context.

It is verified by 98 backend tests and 20 browser workflows. What it is not is a distributed store; a killed writer can leave its lease behind, and the app will not steal it."

## What I would do next

- Per-record version columns. `astraupskill/05-PRACTICE.md` exercise 6 asks for exactly this: add a version to a record and use a conditional update, then contrast it with the workspace-wide revision, where an unrelated accepted change can conflict your edit because the whole file is the transaction boundary.
- Split `src/server/services.js`. It is 2051 lines with 32 functions; the fix report indexed it rather than splitting it.
- Make the stuck-lease recovery procedure in `astraupskill/04-TESTING-AND-DEBUGGING.md` executable by someone who has never read `storage.js`.
- Standardise validation status codes. `assertVariantWeights` returns 422 for range errors but 400 for a weight total that is not 100 (`src/server/services.js:324, 338`).
- A streaming byte cap on SDK response parsing, listed as a known open limit in `astraupskill/VERIFICATION.md`.
