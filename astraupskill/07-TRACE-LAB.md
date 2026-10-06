# Trace lab: prove what one request does

Use a new disposable workspace created by the documented setup command. Keep browser developer tools open on the Network panel. Do not export an unredacted network archive: authorization headers contain your token. The goal is to explain one request precisely, including the paths where it is rejected.

## Where Lab A stops being about the browser

Follow the request into `createFlag` and read the order of the guards: role, then required fields, then project write permission, then key uniqueness, then the per-project limit. Nothing here trusts the identifiers the browser already knows. From `src/server/services.js:837-853`:

```js
    createFlag(actor, input) {
      requireAdminRole(actor);
      const state = store.getState();
      assert(
        input.projectId && input.key && input.name && input.type,
        400,
        "Missing required flag fields",
      );
      assert(FLAG_TYPES.includes(input.type), 400, "Invalid flag type");
      requireProjectWrite(state, actor, input.projectId);
      assertUniqueFlagKey(state, input.key);
      assert(
        state.featureFlags.filter((item) => item.projectId === input.projectId)
          .length < state.resourceLimits.maxFlagsPerProject,
        409,
        "Flag limit reached for this project",
      );
```

## Lab A: create, edit, and inspect history

Create a development-only flag with key `trace_banner`. Before clicking Save, write down the expected resource fields and their types. Inspect the submitted JSON and `If-Match` header. A boolean must be JSON `false` or `true`, not a string. Record the response status, returned identifier, and accepted workspace revision without copying credentials.

Follow these hops: the submit handler in [app.js](../src/ui/app.js) (1164-1196); `POST /api/admin/flags` in [router.js](../src/server/router.js) (181-188); the wrapper in [services.js](../src/server/services.js) (2017-2048), which runs `validateOperation("createFlag", ...)` against the schema at `src/server/contracts.js:322-325`; `createFlag` (837-910); and `mutate` and `#commit` in [storage.js](../src/server/storage.js) (277-318, 228-260). At each boundary, answer three questions. What is trusted now? What is still untrusted? Which layer owns the next decision? The browser knowing the project identifier does not prove the token may write to that project.

Predict before you click: a create with no `environmentIds` targets *every* environment enabled for the project (`services.js:855-861`). The seed project has only Development and Production enabled (pre-production and test exist, but are not mapped to it), so such a create needs `CONFIRM:production` (868-872). The UI's create form preselects Development only (the `fallback` at `src/ui/app.js:344-349`), which is why the first save does not ask for acknowledgment.

Edit only the description. Confirm the PATCH contains the description plus any necessary confirmation, rather than a stale copy of every field. Locate the resulting audit entry in the bootstrap response and interface. Explain why the audit event and changed flag belong in one accepted mutation. If audit creation failed after the flag was independently saved, history could incorrectly suggest no change happened.

## Lab B: compare two writers

Load the flag in two tabs. In A, edit the name. In B, change the description and save. Attempt A's stale save. Record the old header revision and the conflict response. Before review, verify that A's input still contains the edited name. Load latest while keeping the draft; compare the accepted description and changed name. Continue, save, and read both values back.

Sketch three objects on paper: the editor baseline, the user's changed fields, and the latest accepted record. The reviewed editor is built from the latest record with only the changed fields reapplied. This representation is the reason another editor's untouched description survives. Explain what happens if both users changed the name: this UI requires explicit review but does not automatically merge conflicting text.

## Lab C: protect related configuration

Create a segment for a user plan and attach it to a production strategy. Change the segment's constraint. The segment is not an environment, but its update affects a protected environment through the referencing strategy. The service walks that relationship in `updateSegment` (`services.js:1028-1036`): every strategy that lists the segment demands confirmation for its own environment. The seed already contains this shape. "Beta users" is referenced by the production rollout strategy, so `service.updateSegment(admin, segmentId, { description: "x" })` in a `serviceFixture` test fails with 409 `Protected environment "production" requires confirmation`, and passes with `confirmation: ["CONFIRM:production"]`. Then find the browser's version of the same traversal: for a segment, `src/ui/app.js:869-872` collects the environments of every strategy that references it, and only protected ones need acknowledgment (878-880).

Attempt to delete the referenced segment. Explain why refusing deletion is more accurate than silently treating its missing constraints as unrestricted. Then remove its reference through an accepted strategy edit, acknowledge the protected change, and delete the segment. Check that the accepted audit history remains available.

## Lab D: distinguish configuration from context

You can do this lab without the browser, because evaluation is pure. Save the script below as `lab-d.mjs` in the project root (delete it afterwards) and run `node lab-d.mjs`:

```js
import { buildSeedState } from "./src/server/defaults.js";
import { compileSnapshot } from "./src/core/snapshot.js";
import { evaluateSnapshot } from "./src/core/evaluation.js";
const state = buildSeedState();
const production = state.environments.find((e) => e.key === "production");
const snapshot = compileSnapshot(state, state.projects[0].id, production.id);
for (const context of [
  { userId: "a", plan: "pro" }, { userId: "b", plan: "free" }, { userId: "d", plan: "pro" }, { userId: "d", plan: "free" }, { plan: "pro" },
]) {
  const [checkout] = evaluateSnapshot(snapshot, context);
  console.log(snapshot.etag, JSON.stringify(context), checkout.enabled, checkout.variant?.name ?? null, checkout.reasons.join(" | "));
}
```

On 2026-10-06 it printed:

```text
W/"checkout-production-1" {"userId":"a","plan":"pro"} false null Bucket 70 > 25
W/"checkout-production-1" {"userId":"b","plan":"free"} false null Constraint mismatch: plan in pro,enterprise
W/"checkout-production-1" {"userId":"d","plan":"pro"} true treatment Within gradual rollout bucket
W/"checkout-production-1" {"userId":"d","plan":"free"} false null Constraint mismatch: plan in pro,enterprise
W/"checkout-production-1" {"plan":"pro"} false null Missing stickiness field "userId"
```

Buckets depend only on the flag's `groupId` and the user id, so these lines are the same on any machine. Five contexts produce three different outcomes under one configuration ETag. Now read [sdk/request.js](../sdk/request.js) (47-48 refuse any non-200) and `evaluateClient` (`services.js:1654-1656`). Explain why a configuration ETag cannot stand in for the second user's result. Then do the same through the UI's playground with a disposable workspace: the playground posts to `/api/admin/playground` (`src/ui/app.js:1388`), and you should see the same decisions.

Finish with a one-page review note: the accepted invariants, one failure reproduced, the source boundary responsible, and the evidence collected. State which checks used the browser, which used services directly, and which injected filesystem errors. These are complementary observations, and keeping their scope explicit makes your conclusion easier for another engineer to trust.
