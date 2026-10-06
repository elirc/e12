# Codebase map and request ownership

Begin with [package.json](../package.json). The app uses Node's standard library and browser APIs rather than a server framework or a database package. It has no `dependencies` and no lockfile. `npm start` launches the server, `npm run setup` explicitly creates a workspace, and `npm test` runs [verification/run-tests.js](../verification/run-tests.js), which passes every `test/*.test.js` file to `node --test`. This small implementation contains the same responsibilities you will meet inside larger frameworks.

## Modules by size and job

Line counts were taken with `wc -l` on 2026-10-06.

| File | Lines | Owns |
|---|---|---|
| `src/server/server.js` | 114 | Loopback HTTP server, static-file allowlist, request pipeline (`createAppServer`, line 31) |
| `src/server/http-boundary.js` | 167 | Host/origin/method checks, 64 KiB JSON body reader, `If-Match` parsing |
| `src/server/router.js` | 448 | URL + method to service call; sets the `ETag` response header (lines 12-20) |
| `src/server/contracts.js` | 392 | Per-operation input schemas (`validateOperation`, line 346) |
| `src/server/services.js` | 2051 | Domain rules, authorization, audit (index below) |
| `src/server/storage.js` | 363 | `PlatformStore`: lease, version check, atomic commit, snapshot cache |
| `src/server/store.js` | 2 | Re-export of `PlatformStore` kept for old import paths |
| `src/server/defaults.js` / `setup.js` | 329 / 74 | Seed data and the explicit owner-setup command |
| `src/core/evaluation.js` | 450 | Pure evaluation: constraints, rollout, variants, dependencies |
| `src/core/snapshot.js` | 94 | Compiles one project/environment into an evaluation-ready object |
| `src/core/hash.js` | 19 | SHA-256 helpers, IDs, `bucketValue` |
| `src/core/constants.js` | 71 | Enums, default resource limits, seed demo tokens |
| `src/ui/app.js` | 1413 | Single-page admin UI (no framework) |
| `sdk/request.js`, `server-sdk.js`, `browser-sdk.js` | 81 / 24 / 62 | Evaluation clients |

## Function index for `src/server/services.js`

The file is 2051 lines and was left whole (splitting it is a larger refactor than this course should carry). It has 32 top-level functions. `grep -nE "^(export )?(async )?function" src/server/services.js` regenerates this index.

| resource | functions (line) |
|---|---|
| shared | `createError` (21), `assert` (28), `nowIso` (34), `actorFromRecord` (73), `requireScope` (115), `requireAdminRole` (123), `requireInstanceAdmin` (135), `detectDependencyCycle` (354), `createPlatformService` (437) |
| project | `getProject` (38), `getProjectMembership` (50), `canReadProject` (145), `canWriteProject` (158), `requireProjectRead` (177), `requireProjectWrite` (187), `auditProjectId` (197), `assertProjectEnvironmentSelection` (256), `assertSegmentsBelongToProject` (300) |
| environment | `getEnvironment` (42), `assertProtectedEnvironmentConfirmation` (271) |
| flag | `getFlag` (46), `assertUniqueFlagKey` (249), `confirmFlagChanges` (288), `serializeFlag` (387), `filterFlags` (414) |
| token | `getActorFromToken` (56), `issuePlaintextToken` (426), `readTokenFromHeaders` (430) |
| audit | `visibleAudit` (213), `appendAudit` (225) |
| variant | `assertVariantWeights` (312), `assertSiblingVariantWeights` (341) |

Inside `createPlatformService`, the operations are methods on one object literal: `createFlag` (837), `updateFlag` (912), `changeFlagLifecycle` (950), `updateSegment` (1009), `createStrategy` (1058), `updateStrategy` (1153), `createVariant` (1237), `updateVariant` (1282), `evaluateClient` (1641) and others. All seven `delete*` operations are generated in one loop (1810-2007). The loop at 2010-2049 then wraps every operation. That wrapper is the most important piece of the file and is easy to miss (see below).

## Follow one write: PATCH a flag description

Read these hops in order. Each one owns a single decision.

1. **Browser builds the diff.** In [src/ui/app.js](../src/ui/app.js), `readForm` (668) reads every widget into typed values, and `changes` (680-689) keeps only the fields that differ from `state.editor.baseValues`. The submit listener (1164) sends that diff plus `confirmation` as a PATCH. Its `revision` is the one the editor loaded (1193). `api()` turns the revision into `If-Match: "<n>"` for every write (176).
2. **Server reads the body before anything else.** In [server.js](../src/server/server.js), lines 41-42 await `readJsonBody` for POST/PATCH/DELETE *before* any state is captured. Line 43 calls `writeVersion`, and line 44 opens `store.runRequest(expectedVersion, ...)`. A slow upload therefore cannot hold a stale view of the workspace while it trickles in.
3. **Boundary checks.** [http-boundary.js](../src/server/http-boundary.js) `validateRequest` (22-57) refuses a non-loopback `Host`, a cross-origin `Origin` and `Sec-Fetch-Site: cross-site` on writes. `writeVersion` (59-75) returns 428 unless an admin write carries `If-Match: "<positive integer>"`. `readJsonBody` (106-167) caps the body at 64 KiB and refuses `__proto__`-style keys.
4. **Route.** [router.js](../src/server/router.js) matches `PATCH /api/admin/flags/:flagId` at 190-202. It asks for an actor with `write` scope and calls `service.updateFlag`.
5. **Wrapper re-authorizes and validates.** The wrapper at [services.js](../src/server/services.js) 2017-2048 looks the token up *again* in the request's state (2020-2026). A token revoked a moment ago therefore stops working mid-request. The wrapper then re-derives the actor, demands `write` scope for any `create|update|delete|revoke|change` method (2028-2041), and runs `validateOperation` from [contracts.js](../src/server/contracts.js) on the input (2042-2045). Tests that call the service directly get the same checks as HTTP callers.
6. **Domain rule.** `updateFlag` (912-948) checks that the flag exists (404), project write access (`requireProjectWrite`, 403), and confirmation for every protected environment the flag is mapped to (`confirmFlagChanges`, 409). Then it calls `store.mutate`. Inside the mutator, only fields present in the input are copied (927-936), and `appendAudit` records before and after in the same draft.
7. **Persistence.** [storage.js](../src/server/storage.js) `mutate` (277-318) takes the lease, re-reads the file, compares version *and* SHA-256 digest with what the request started from (292-301), runs the mutator on a `structuredClone`, bumps `meta.version`, and calls `#commit` (228-260). `#commit` writes a unique `.tmp`, `fsync`s it, renames it over the real file, and only then publishes the new state in memory.
8. **Response.** `sendJson` (router.js 12-20) sets `ETag: "<new revision>"`. The UI reads it back as the editor's next revision (app.js 214).

[store.js](../src/server/store.js) is only a compatibility export. If you read it first, you will think persistence is trivial.

## Understand the relationships

Labelled arrows: **owns** means deleting the parent removes the child. **references** means the child blocks deletion of the target.

| From | To | Kind | Where the rule lives |
|---|---|---|---|
| project | projectMembers, projectEnvironments | owns | removed with the project (services.js 1953-1960) |
| project | flags, segments, tokens, metrics | references | project delete refused while any exist (1844-1856) |
| flag | featureFlagEnvironments, strategies, variants | owns | cascade on flag delete (1961-1984), only after the flag is archived (1894-1898) |
| flag | flagDependencies, metricsImpressions | references | flag delete refused (1899-1910) |
| strategy | variants | owns | cascade on strategy delete (1961-1974) |
| strategy | segments | references | segment delete refused while referenced (1912-1919) |
| environment | anything mapped to it | references | environment delete refused (1865-1887) |

Segments are project-scoped or global (`projectId: null`). Creating, editing or deleting a global segment requires an instance administrator (968, 1016, 1837-1839). Draw this table as a diagram once. Unlabelled arrows hide the design decision that matters most.

## Follow one evaluation

`POST /api/client/evaluate` (router.js 402-406) and `POST /api/client/features` (408-412) both call `evaluateClient` (services.js 1641-1686). That function:

- resolves the bearer token and requires the `evaluate` scope. The project and environment come from the token itself (1648-1650), not from the request.
- calls `store.getSnapshot` (storage.js 320-338). It caches `compileSnapshot` output under `[projectId, environmentId, meta.version, digest]`, with at most 200 entries.
- validates the submitted context (1656) and applies a per-token rate limit (1662-1670).
- calls `evaluateSnapshot` ([evaluation.js](../src/core/evaluation.js) 445-450) for this context. It returns `reasons` only when `debug: true` was requested by a non-frontend token (1672).

The configuration snapshot is cached. The decision for one context never is. The [server SDK](../sdk/server-sdk.js) and [browser SDK](../sdk/browser-sdk.js) share [request.js](../sdk/request.js). The browser SDK numbers its refreshes (browser-sdk.js 36-49), and only the newest requested context may publish to subscribers.

## Where to inspect evidence

There are 98 `test(...)` cases across 11 files: `storage` 19, `crud` 13, `http` 11, `authorization` 10, `sdk` 10, `contracts` 9, `evaluation-safety` 9, `metrics` 8, `evaluation` 4, `services` 3, `context-cache` 2. The non-test module you will use most is [fixtures.js](../test/fixtures.js). It exports `serviceFixture(t, alter)`, which builds a seeded store in a fresh temp directory and cleans up after the test. The practice exercises reuse it. [verify_browser.py](../verification/verify_browser.py) drives the real DOM against a disposable loopback server. Start from the test nearest your change, then follow its fixture into the implementation.
