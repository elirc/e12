# Codebase map and request ownership

Begin with [package.json](../package.json). The app uses Node's standard library and browser APIs rather than a server framework or a database package. `npm start` launches the server, `npm run setup` explicitly creates a workspace, and `npm test` invokes the repository's test runner. Understanding this small implementation will help you recognize the same responsibilities inside larger frameworks.

## Function index for `src/server/services.js`

The file is 2052 lines and was left whole (splitting it is a larger refactor than this course should carry). Use this index for the "follow one flag" exercise; line numbers are as of the fix pass (`grep -n "^\(export \)\?\(async \)\?function" src/server/services.js` regenerates it).

| resource | functions (line) |
|---|---|
| shared | `createError` (21), `assert` (28), `nowIso` (34), `actorFromRecord` (73), `requireScope` (115), `requireAdminRole` (123), `requireInstanceAdmin` (135), `detectDependencyCycle` (354), `createPlatformService` (437) |
| project | `getProject` (38), `getProjectMembership` (50), `canReadProject` (145), `canWriteProject` (158), `requireProjectRead` (177), `requireProjectWrite` (187), `auditProjectId` (197), `assertProjectEnvironmentSelection` (256), `assertSegmentsBelongToProject` (300) |
| environment | `getEnvironment` (42), `assertProtectedEnvironmentConfirmation` (271) |
| flag | `getFlag` (46), `assertUniqueFlagKey` (249), `confirmFlagChanges` (288), `serializeFlag` (387), `filterFlags` (414) |
| token | `getActorFromToken` (56), `issuePlaintextToken` (426), `readTokenFromHeaders` (430) |
| audit | `visibleAudit` (213), `appendAudit` (225) |
| variant | `assertVariantWeights` (312), `assertSiblingVariantWeights` (341) |

## Follow one write

In [src/ui/app.js](../src/ui/app.js), find `definitions`, `readForm`, `changes`, and the editor's submit listener. Definitions describe labeled widgets for each resource. `readForm` converts input into typed values; `changes` compares those values with the editor's accepted baseline. Updating a flag description therefore sends a PATCH with that changed field, rather than replacing every property with whatever happened to be rendered earlier. The request includes the editor's workspace revision in `If-Match`.

[server.js](../src/server/server.js) creates the loopback HTTP server and serves only the explicit static-file allowlist. [http-boundary.js](../src/server/http-boundary.js) owns host, origin, method, body-size, JSON-shape, and revision-header checks. Body parsing happens before the request captures a storage snapshot. This matters when a slow request overlaps another editor's accepted change: authorization and mutation must inspect a consistent, current operation state.

[router.js](../src/server/router.js) maps URL and method to a service operation. Find PATCH `/api/admin/flags/:flagId`, then follow its call into [services.js](../src/server/services.js). The service owns the domain rule: the flag must exist, the actor must have write permission in its project, protected environments require confirmation, and the input must satisfy [contracts.js](../src/server/contracts.js). A successful mutation updates the record and appends audit history in the same private draft.

[store.js](../src/server/store.js) is a small compatibility export. The actual persistence boundary is [storage.js](../src/server/storage.js). It acquires a writer lease, compares accepted revision and file digest, clones a draft, validates and serializes it, writes and flushes a same-directory temporary file, and replaces the accepted file before publishing memory state. Read this sequence before changing any service code that calls `mutate`.

## Understand the relationships

Projects contain flags and have project-member and project-environment mappings. An environment can be available to several projects. A flag has environment mappings; each strategy belongs to one flag and one environment. Strategies reference reusable segments and own variants. A dependency connects a parent and child flag within one project. A token either represents a personal identity or evaluates one project/environment pair. Audit entries retain accepted-change history. Metrics retain evaluation information and can block destructive deletion of referenced configuration.

For example, deleting a strategy can remove its owned variants, while deleting a shared segment is refused if a strategy still references it. Both are reasonable behaviors because ownership differs. Draw these relationships with arrows labeled “owns” or “references”; unlabeled arrows hide the most important design decision.

## Follow one evaluation

[snapshot.js](../src/core/snapshot.js) compiles project/environment configuration into a convenient representation. [evaluation.js](../src/core/evaluation.js) evaluates constraints, strategies, variants, and dependencies for a submitted context. This path is separate from administration. An evaluation does not create or edit a flag. The configuration snapshot can be cached, but its decision for user A must not be reused as user B's result.

The [server SDK](../sdk/server-sdk.js) and [browser SDK](../sdk/browser-sdk.js) share [request.js](../sdk/request.js). The browser SDK additionally manages subscribed state and overlapping refresh requests. The newest requested context owns publication; a slower old response cannot restore a previous user's flags.

## Where to inspect evidence

[authorization.test.js](../test/authorization.test.js) exercises scope and project boundaries. [crud.test.js](../test/crud.test.js) covers resource relationships and mutation rules. [storage.test.js](../test/storage.test.js) injects persistence failures. [verify_browser.py](../verification/verify_browser.py) drives the actual DOM and loopback server with disposable data. Start with the test nearest your proposed change, then follow its fixture into the real implementation. Avoid adding a new layer merely because a framework tutorial has one; introduce structure when it clarifies ownership or reduces a demonstrated source of mistakes.
