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

Follow the submit handler in [app.js](../src/ui/app.js), the route in [router.js](../src/server/router.js), the operation wrapper and `createFlag` in [services.js](../src/server/services.js), and the mutation sequence in [storage.js](../src/server/storage.js). At each boundary, answer: what is trusted now, what is still untrusted, and which layer owns the next decision? The browser knowing the project identifier does not prove the token may write to that project.

Edit only the description. Confirm the PATCH contains the description plus any necessary confirmation, rather than a stale copy of every field. Locate the resulting audit entry in the bootstrap response and interface. Explain why the audit event and changed flag belong in one accepted mutation. If audit creation failed after the flag was independently saved, history could incorrectly suggest no change happened.

## Lab B: compare two writers

Load the flag in two tabs. In A, edit the name. In B, change the description and save. Attempt A's stale save. Record the old header revision and the conflict response. Before review, verify that A's input still contains the edited name. Load latest while keeping the draft; compare the accepted description and changed name. Continue, save, and read both values back.

Sketch three objects on paper: the editor baseline, the user's changed fields, and the latest accepted record. The reviewed editor is built from the latest record with only the changed fields reapplied. This representation is the reason another editor's untouched description survives. Explain what happens if both users changed the name: this UI requires explicit review but does not automatically merge conflicting text.

## Lab C: protect related configuration

Create a segment for a user plan and attach it to a production strategy. Change the segment's constraint. Even though the segment itself is not an environment, its update affects a protected environment through the referencing strategy. Locate the service's traversal of these relationships and the interface's acknowledgment display. Try the same update without confirmation through a synthetic test, and confirm rejection.

Attempt to delete the referenced segment. Explain why refusing deletion is more accurate than silently treating its missing constraints as unrestricted. Then remove its reference through an accepted strategy edit, acknowledge the protected change, and delete the segment. Check that the accepted audit history remains available.

## Lab D: distinguish configuration from context

Configure a strategy requiring `plan` in `["pro"]`. Evaluate `{ "userId": "a", "plan": "pro" }`, then `{ "userId": "b", "plan": "free" }` without editing configuration. Record the differing decisions and identical configuration revision. Read [sdk/request.js](../sdk/request.js) and [evaluation.js](../src/core/evaluation.js). Explain why a configuration ETag cannot stand in for the second user's result.

Finish with a one-page review note: the accepted invariants, one failure reproduced, the source boundary responsible, and the evidence collected. State which checks used the browser, which used services directly, and which injected filesystem errors. These are complementary observations, and keeping their scope explicit makes your conclusion easier for another engineer to trust.
