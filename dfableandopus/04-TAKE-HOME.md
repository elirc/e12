# Take-home: scheduled flag expiry

Budget three to four hours. Written the way a hiring team would hand it to you against this repository.

## Context you are given

The whole workspace is one JSON document. Administrative writes carry the reviewed revision in `If-Match` and commit through `store.mutate` (`src/server/storage.js:277-318`). Flags are created by `createFlag` (`src/server/services.js:837`) and validated by the contract helpers in `src/server/contracts.js`. No runtime dependencies; the test runner is Node's own.

## The assignment

Temporary flags are the ones nobody cleans up. Add an **expiry date** to a feature flag so a release flag can be created with a date after which it must not evaluate as enabled.

### Requirements

1. **Persistence.** A flag record may carry an optional `expiresAt`, an ISO-8601 instant string. Existing flags without the field must keep loading unchanged; do not rewrite the workspace to backfill it. The precedent to follow is `legacy files without schemaVersion are readable without automatic rewriting` (`test/storage.test.js:299`).
2. **Validation.** `expiresAt`, when present, must be a parseable instant strictly in the future at creation time. Reject with 422 and a message naming the field. Put the check with the other resource-shape helpers in `src/server/contracts.js` next to `validateStrategySettings` (line 186), not inline in the service.
3. **HTTP boundary.** `POST /api/admin/flags` and `PATCH /api/admin/flags/:id` accept the field. Both remain subject to the existing `If-Match` precondition, so a create or update with a stale revision still returns 409 and one with no header still returns 428 (`src/server/http-boundary.js:59-75`). Clearing an expiry is an explicit `{"expiresAt": null}`, not an omitted key.
4. **Evaluation.** An expired flag evaluates to disabled with a reason string that says the flag expired, resolved before strategies are considered in `src/core/evaluation.js`. The evaluation must not mutate state, must not consume a workspace revision, and must stay pure with respect to the compiled snapshot.
5. **Snapshot correctness.** `getSnapshot` caches by project, environment, `meta.version` and digest (`src/server/storage.js:320-338`). Decide and justify in writing whether expiry is baked into the compiled snapshot or applied at evaluation time against the request clock. Only one of those is correct; say why.
6. **Protected environments.** Setting or clearing an expiry on a flag mapped to a protected environment must still require the `CONFIRM:<envKey>` acknowledgment enforced by `assertProtectedEnvironmentConfirmation` (`src/server/services.js:271-286`), and must still write an audit entry through `appendAudit`.

### Out of scope

No background job, no UI work beyond whatever is needed for you to exercise the field manually, no migration tooling.

## Tests you must write

Add cases to **`test/evaluation.test.js`** and **`test/contracts.test.js`**, and one persistence case to **`test/storage.test.js`**. Run them with:

```
node --test test/evaluation.test.js test/contracts.test.js test/storage.test.js
```

and the full suite with `npm test`, which runs `node verification/run-tests.js`.

Minimum cases:

- a flag with `expiresAt` in the past evaluates disabled with the expiry reason, even when a `enabled_for_all` strategy matches;
- a flag with `expiresAt` in the future is unaffected;
- a flag with no `expiresAt` behaves exactly as before;
- a create with a past `expiresAt` returns 422 and the workspace revision does not change;
- a workspace file written without `expiresAt` loads and mutates without the field being introduced.

## What to submit

- The diff, as a patch or a branch.
- A short `NOTES.md`: the snapshot-versus-request-clock decision and why; what you did about the case where the flag expires between the snapshot being compiled and the request arriving; anything you left undone and what you would do with another hour.
- The exact commands you ran and their output, pass and fail. Preserve the failing output from before your fix if you wrote the test first.

## Grading rubric

| Criterion | Strong submission | Weak submission |
|---|---|---|
| Invariant stated | `NOTES.md` names one rule, for example "an expired flag never evaluates enabled regardless of strategy", and the code has one place that enforces it | The rule is implied by the diff; expiry is checked in two or three places that can drift apart |
| Snapshot decision | Applies expiry at evaluation time against the request clock, and explains that time is not part of the snapshot cache key, so a snapshot cached at `meta.version` 41 would otherwise serve an expired flag as live until the next write | Bakes `expiresAt` resolution into `compileSnapshot`, producing a flag that stays enabled after expiry until an unrelated mutation invalidates the cache |
| Backward compatibility | Optional field, absent means never expires, no rewrite of existing records, proven by a test that loads a file lacking the field | Adds the field to `validateState` requirements or backfills on read, breaking existing workspaces |
| Boundary discipline | Validation lives in `contracts.js`, authorization and confirmation in `services.js`, shape and identity only in `storage.js` | A date check inside `validateState`, or an authorization check inside the evaluation core |
| Error paths and codes | 422 for an unparseable or past date with the field named; 409 still returned for a stale revision; 428 still returned for a missing `If-Match` | Returns 400 for everything, or bypasses the precondition on the new field |
| Tests | Tests assert consequences, name the real behavior in the test title, and include the negative case where the revision does not advance | One happy-path assertion; no test that the workspace revision is unchanged after a rejected create |
| Explicit-null semantics | `{"expiresAt": null}` clears, an omitted key leaves the value alone, and there is a test for each | Omitted key silently clears the expiry, so any unrelated PATCH removes it |

## Reviewer's notes

What I open first, in order:

1. **The test file**, before the implementation. If the only new test is "creating a flag with an expiry works", this is a two-hour pass at a four-hour problem. I want the past-date rejection that also asserts `meta.version` did not advance, because that proves you understood a rejected request must not consume a revision.
2. **Where the date check landed.** A date parse inside `validateState` is the fastest way to fail this; that function is documented at `src/server/storage.js:108-110` as checking shape and identity only.
3. **Migration safety.** I will hand your branch a workspace JSON that predates your change and run `npm test`. If it throws, we stop there.
4. **The clock.** Where does "now" come from in evaluation? Threading it through as a parameter beats `Date.now()` buried in a pure function; if you did the latter, say in `NOTES.md` how you would inject it.
5. **The null case.** Explicit null versus omitted key is the detail most candidates skip, and the one that causes an incident six weeks later when an unrelated rename clears every expiry.
6. **Honesty in `NOTES.md`.** Naming the case you did not handle scores above silence. Claiming behavior the code does not have is the only thing that turns a partial pass into a no.
