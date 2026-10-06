# Practice exercises with runnable checks

Work in your own clone and keep your starting commit so you can diff against it. The exercises run from easy to hard:

- **Observation (1, 2, 4, 5, 6).** The harness passes against the code as it is. Your job is to explain *why* it passes, then break the code on purpose and watch the harness catch it.
- **Change (3, 7, 8).** One test in the harness fails today and passes once you make the change (for 8, the harness pins the server contract and the change is in the UI).
- **Design (9-13).** These need a written decision or design before any code. Exercise 9 includes a harness that pins today's behavior.

Every harness is a dependency-free `node:test` file. Save it under `test/`, run it alone with `node --test test/<file>`, then run `npm test` to confirm the other 98 cases still pass. `npm test` picks up any `test/*.test.js` file, so delete your practice files before you compare totals with the baseline. Each harness below was run against the repository on 2026-10-06 with Node 22.16. The stated pass/fail results are what that run produced.

---

## 1. Rollout bucketing is deterministic (observe)

**Goal.** Explain how a percentage rollout picks users without storing any assignment.

**Hints.** Read `bucketValue` (`src/core/hash.js:15-19`) and `matchGradualRollout` (`src/core/evaluation.js:167-191`). `evaluateFlag` (`evaluation.js:310`) only needs a flag record and a snapshot-shaped object, so you can build both by hand.

Save as `test/practice-01-bucketing.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { bucketValue } from "../src/core/hash.js";
import { evaluateFlag } from "../src/core/evaluation.js";

const flag = { id: "flag_a", key: "banner", archived: false };
const snapshotFor = (rollout) => ({
  segmentsById: {},
  flagsById: {},
  defaultStrategy: null,
  flags: [],
  _record: {
    flag,
    dependencies: [],
    strategies: [{ id: "s1", name: "Rollout", type: "gradual_rollout",
      parameters: { rollout }, constraints: [], segmentIds: [], variants: [] }],
  },
});
const run = (rollout, context) => {
  const snapshot = snapshotFor(rollout);
  return evaluateFlag(snapshot._record, snapshot, context);
};

test("the same identity always lands in the same bucket, 1..100", () => {
  const first = bucketValue("banner:user-42");
  assert.equal(bucketValue("banner:user-42"), first);
  assert.ok(first >= 1 && first <= 100);
});

test("rollout 0 enables nobody and 100 enables everybody", () => {
  for (let i = 0; i < 200; i += 1) {
    assert.equal(run(0, { userId: `u${i}` }).enabled, false);
    assert.equal(run(100, { userId: `u${i}` }).enabled, true);
  }
});

test("a missing stickiness field is a refusal, not a random bucket", () => {
  const result = run(100, { plan: "pro" });
  assert.equal(result.enabled, false);
  assert.match(result.reasons[0], /Missing stickiness field "userId"/);
});

test("a user is inside the rollout exactly when bucket <= rollout", () => {
  for (const userId of ["a", "b", "c", "d"]) {
    const bucket = bucketValue(`banner:${userId}`); // groupId defaults to the flag key
    assert.equal(run(bucket, { userId }).enabled, true);
    assert.equal(run(bucket - 1, { userId }).enabled, false);
  }
});
```

**Check.** 4/4 pass. Next, change `matched: bucket <= rollout` to `matched: bucket < rollout` on `evaluation.js:184` and rerun. Only the last test fails. The "rollout 0 / rollout 100" test still passes, because none of its 200 sample users happens to land in bucket 100. Boundary bugs hide from sampled tests, so test the boundary directly. Revert the change. In one sentence, explain why the bucket range is 1..100 and not 0..99.

## 2. Missing data never switches a flag on (observe)

**Goal.** Show that negated rules (`not_in`, `inversion: true`) cannot match a context that lacks the field.

**Hints.** `matchConstraint` (`evaluation.js:27-125`). Look at `ownValue` (11-14) and the early `return false` on line 56.

Save as `test/practice-02-missing-context.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { matchConstraint } from "../src/core/evaluation.js";

const notPro = { field: "plan", operator: "not_in", values: ["pro"] };
const invertedPro = { field: "plan", operator: "in", values: ["pro"], inversion: true };

test("a present value is compared normally", () => {
  assert.equal(matchConstraint(notPro, { plan: "free" }), true);
  assert.equal(matchConstraint(notPro, { plan: "pro" }), false);
  assert.equal(matchConstraint(notPro, { plan: "PRO" }), false); // case-insensitive by default
});

test("a missing or non-scalar value never matches, even through negation", () => {
  assert.equal(matchConstraint(notPro, {}), false);
  assert.equal(matchConstraint(invertedPro, {}), false);
  assert.equal(matchConstraint(notPro, { plan: ["free"] }), false);
});

test("inherited properties are not context values", () => {
  const context = Object.create({ plan: "free" });
  assert.equal(matchConstraint(notPro, context), false);
});
```

**Check.** 3/3 pass. Then delete line 56 (`if (!scalar(rawValue)) return false;`). The second and third tests should fail: `undefined` is not in `["pro"]`, so `not_in` matches, and the same happens for an inherited property. Revert, and write down which real flag this would have turned on for anonymous users.

## 3. Make one validation message consistent (change)

**Goal.** Every contract error starts with a `body.`-prefixed field path, so the UI and API callers know which field failed. One message does not.

**Hints.** `validateOperation` (`src/server/contracts.js:346-362`) calls `validateStrategySettings(result)` on line 356 without a field name, so the default `"strategy"` is used (186). The missing-rollout rejection on line 191 then reports `strategy: ...` instead of naming the field.

Save as `test/practice-03-error-prefix.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { validateOperation } from "../src/server/contracts.js";

const create = (parameters) =>
  validateOperation("createStrategy", {
    type: "gradual_rollout", flagId: "flag_a", environmentId: "env_a",
    ...(parameters ? { parameters } : {}),
  });

test("out-of-range and wrong-type rollouts name the field and the range", () => {
  for (const rollout of [101, -1, 2.5, "25"])
    assert.throws(() => create({ rollout }), {
      status: 422,
      message: "body.parameters.rollout: must be an integer from 0 to 100",
    });
  assert.doesNotThrow(() => create({ rollout: 0 }));
  assert.doesNotThrow(() => create({ rollout: 100 }));
});

test("a missing rollout uses the same body.* field prefix as every other error", () => {
  assert.throws(() => create(), {
    status: 422,
    message: "body.parameters.rollout: gradual rollout requires a rollout percentage",
  });
});
```

**Check.** Today the first test passes and the second fails with `strategy: gradual rollout requires a rollout percentage`. After your change both pass, and `npm test` still reports 98/98 for the original files. Note that the out-of-range message is *already* good. The first test exists so your change cannot break it.

## 4. Variant bookkeeping traps (observe, then decide)

**Goal.** Find out what an administrator actually experiences when building or trimming a multivariate strategy.

**Hints.** `assertVariantWeights` (`src/server/services.js:312-339`), `assertSiblingVariantWeights` (341-352), `createVariant` (1237-1280), the variant branch of delete (1933-1939), and the contract's `variants` check (`contracts.js:248-269`). The seed's production rollout strategy has a 50/50 `control`/`treatment` split. Production is protected, so deletes need `CONFIRM:production`.

Save as `test/practice-04-variants.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { serviceFixture } from "./fixtures.js";

const CONFIRM = ["CONFIRM:production"];

test("variants cannot be built one at a time", (t) => {
  const { service, admin, createFlag, development } = serviceFixture(t);
  const flag = createFlag("variant_lab");
  const strategy = service.createStrategy(admin, {
    type: "enabled_for_all", flagId: flag.id, environmentId: development.id,
  });
  assert.throws(
    () => service.createVariant(admin, { strategyId: strategy.id, name: "a", weight: 50 }),
    { status: 400, message: "Variant weights must sum to 100" },
  );
  // The whole set has to arrive together through the strategy instead.
  const updated = service.updateStrategy(admin, strategy.id, {
    variants: [{ name: "a", weight: 50 }, { name: "b", weight: 50 }],
  });
  assert.equal(updated.variants.length, 2);
});

test("deleting one half of a 50/50 split is refused", (t) => {
  const { service, admin, store } = serviceFixture(t);
  const state = store.getState();
  const [control] = state.variants;
  const before = state.meta.version;
  assert.throws(
    () => service.deleteVariant(admin, control.id, { confirmation: CONFIRM }),
    { status: 400, message: "Variant weights must sum to 100" },
  );
  assert.equal(store.getState().meta.version, before);
});

test("the same rule family answers 422, 400 or 409 depending on the path", (t) => {
  const { service, admin, createFlag, development } = serviceFixture(t);
  const flag = createFlag("status_lab");
  const strategy = service.createStrategy(admin, {
    type: "enabled_for_all", flagId: flag.id, environmentId: development.id,
    variants: [{ name: "a", weight: 100 }],
  });
  const status = (operation) => {
    try { operation(); } catch (error) { return error.status; }
  };
  // Contract layer (contracts.js variants()): bad sum is 422.
  assert.equal(status(() => service.updateStrategy(admin, strategy.id, {
    variants: [{ name: "a", weight: 60 }, { name: "b", weight: 60 }] })), 422);
  // Service layer (services.js assertVariantWeights): bad sum is 400 ...
  assert.equal(status(() => service.createVariant(admin, {
    strategyId: strategy.id, name: "b", weight: 10 })), 400);
  // ... and a duplicate name is 409.
  assert.equal(status(() => service.createVariant(admin, {
    strategyId: strategy.id, name: "a", weight: 0 })), 409);
});
```

**Check.** 3/3 pass. Write a short paragraph answering two questions. (a) Which status should a semantic validation failure use here, and why? (b) Should per-variant create and delete endpoints exist at all, when the only way to change a split is to send the whole `variants` array to `updateStrategy` (which also gives every variant a new id, `services.js:1199-1218`)? Optional follow-up: standardize the service statuses on 422, then update test 3 and the affected cases in `test/crud.test.js` together.

## 5. Two writers and a stuck lease (observe)

**Goal.** Prove the 409 and 503 paths of `mutate` against real files, and rehearse the manual lease recovery from 04-TESTING-AND-DEBUGGING.

**Hints.** `mutate` (`src/server/storage.js:277-318`), `#withLease` (200-226). A second `PlatformStore` pointed at the same file behaves like a second process.

Save as `test/practice-05-two-writers.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PlatformStore } from "../src/server/store.js";
import { serviceFixture } from "./fixtures.js";

test("a second store with an old version is refused and leaves no trace", (t) => {
  const { store, directory } = serviceFixture(t);
  const file = path.join(directory, "state.json");
  const other = new PlatformStore(file);
  const seen = other.init().meta.version; // both writers have now read version N
  store.mutate((draft) => { draft.projects[0].name = "Winner"; }, seen);
  assert.throws(
    () => other.mutate((draft) => { draft.projects[0].name = "Loser"; }, seen),
    { status: 409 },
  );
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.projects[0].name, "Winner");
  assert.equal(onDisk.meta.version, seen + 1);
  assert.deepEqual(fs.readdirSync(directory), ["state.json"]); // no lock, no .tmp
});

test("a leftover lease blocks writes with 503 and is never removed for you", (t) => {
  const { store, directory } = serviceFixture(t);
  const lock = path.join(directory, "state.json.lock");
  assert.equal(store.lockPath, lock);
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, createdAt: "2026-01-01T00:00:00.000Z" }));
  const version = store.getState().meta.version;
  assert.throws(() => store.mutate(() => {}, version), {
    status: 503, message: "Another writer owns the state lease; retry later",
  });
  assert.ok(fs.existsSync(lock));
  fs.unlinkSync(lock); // the manual recovery step from 04-TESTING-AND-DEBUGGING
  store.mutate(() => {}, version);
  assert.equal(store.getState().meta.version, version + 1);
});
```

**Check.** 2/2 pass. Then replace the condition on `storage.js:292-295` with `false` and rerun. The first test should fail, because the loser's write lands. Revert. Explain why the digest half of that condition is needed even when the version matches (compare with `test/storage.test.js:124`).

## 6. Slow responses cannot publish the wrong user (observe)

**Goal.** Reproduce the browser race from 03-WORKED-CHANGE §5 deterministically, without timers.

**Hints.** `FeatureFlagBrowserClient.refresh` (`sdk/browser-sdk.js:36-49`). `createEvaluator` accepts a `fetchImpl` (`sdk/request.js:3-8`), so you control when each response resolves.

Save as `test/practice-06-browser-race.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { FeatureFlagBrowserClient } from "../sdk/browser-sdk.js";

function controlledFetch() {
  const pending = [];
  const fetchImpl = (url, init) =>
    new Promise((resolve) => pending.push({ context: JSON.parse(init.body).context, resolve }));
  const answer = (index, enabled) =>
    pending[index].resolve({ status: 200, json: async () => ({ flags: [{ key: "banner", enabled, variant: null }] }) });
  return { fetchImpl, answer, pending };
}

test("a slow response for user A cannot overwrite user B's published flags", async () => {
  const { fetchImpl, answer, pending } = controlledFetch();
  const client = new FeatureFlagBrowserClient({ baseUrl: "http://127.0.0.1:3000", token: "t", fetchImpl });
  const forA = client.refresh({ userId: "a" });
  const forB = client.refresh({ userId: "b" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pending.map((item) => item.context.userId), ["a", "b"]);
  answer(1, false); // B (newest) finishes first
  answer(0, true);  // A (stale) finishes last
  assert.equal((await forA).get("banner").enabled, true); // A's caller still gets A's answer
  await forB;
  assert.equal(client.get("banner").enabled, false); // but only B was published
});
```

**Check.** 1/1 pass. Change `if (sequence === this.#sequence)` on line 43 to `if (true)`. The test should fail. Revert. Then add a second test: call `client.clear()` while A is pending, resolve A, and assert that `client.flags.size` is 0.

## 7. Authorize before you validate against stored data (change)

**Goal.** A user without write access to a project should get 403 for *any* strategy edit. Today a malformed edit returns a 422 that is computed from the stored strategy, so it reveals that strategy's type to someone who may not read it.

**Hints.** In `updateStrategy` (`src/server/services.js:1153-1235`), `validateStrategySettings({ ...strategy, ...input })` on line 1158 runs before `requireProjectWrite` on 1160. `updateVariant` has the same order (`validateVariant` at 1288, `requireProjectWrite` at 1299). Use `serviceFixture`'s `alter` callback to add an outsider user and token.

Save as `test/practice-07-authorize-first.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { hashToken } from "../src/core/hash.js";
import { serviceFixture } from "./fixtures.js";

const OUTSIDER = "practice-outsider-token";

function withOutsider(state) {
  // A project_member role holder who is NOT a member of the seed project.
  state.users.push({ id: "usr_outsider", name: "Outsider", email: "outsider@example.test",
    roles: ["project_member"], active: true });
  state.apiTokens.push({ id: "tok_outsider", name: "Outsider PAT", type: "personal",
    hash: hashToken(OUTSIDER), scopes: ["read", "write"], userId: "usr_outsider",
    projectIds: [], environmentIds: [], createdAt: state.meta.updatedAt ?? null,
    revokedAt: null, lastUsedAt: null });
}

test("a non-member is told 403 on a well-formed strategy edit", (t) => {
  const { service, actor, store } = serviceFixture(t, withOutsider);
  const outsider = actor(OUTSIDER, "write");
  const strategy = store.getState().strategies[0];
  assert.throws(() => service.updateStrategy(outsider, strategy.id, { name: "renamed" }),
    { status: 403, message: "Project write access denied" });
});

test("a non-member should also get 403, not a validation hint, on a malformed edit", (t) => {
  const { service, actor, store } = serviceFixture(t, withOutsider);
  const outsider = actor(OUTSIDER, "write");
  const strategy = store.getState().strategies[0]; // enabled_for_all in development
  assert.throws(
    () => service.updateStrategy(outsider, strategy.id, { parameters: { rollout: 10 } }),
    { status: 403 },
  );
});
```

**Check.** Today the first test passes and the second fails with `strategy: only gradual rollout accepts parameters`. Moving the two lines so that the authorization check comes first makes both pass, and the full suite stays green. Apply the same reordering to `updateVariant` and add a matching test.

## 8. Archive filter for the flag list (change, mostly UI)

**Goal.** Add an explicit Active / Archived / All filter to the flag list in the admin UI.

**Hints.** The server half already exists. `GET /api/admin/flags?archived=true|false` is parsed at `src/server/router.js:175-176` and applied in `filterFlags` (`services.js:418-422`). The UI loads every flag once through `GET /api/admin/bootstrap` (`src/ui/app.js:1066`, served at `router.js:79-98`), then filters and pages 20 rows at a time on the client (`app.js:914-971`). The work is therefore in `src/ui/app.js`. Decide the default, whether the choice survives switching resource kind, and what happens to the current page when the filtered count shrinks. Keep `state.editor` separate from the visible list, so that a record dropping out of view does not discard an unsaved draft.

Save as `test/practice-08-archived-filter.test.js` (it pins the server contract your UI relies on):

```js
import test from "node:test";
import assert from "node:assert/strict";
import { serviceFixture } from "./fixtures.js";

test("the server already filters flags by archived state", (t) => {
  const { service, admin, createFlag } = serviceFixture(t);
  const flag = createFlag("filter_lab");
  service.changeFlagLifecycle(admin, flag.id, "archive");
  const keys = (query) => service.listFlags(admin, query).map((item) => item.key).sort();
  assert.deepEqual(keys({ archived: true }), ["filter_lab"]);
  assert.ok(!keys({ archived: false }).includes("filter_lab"));
  assert.equal(keys({}).length, keys({ archived: true }).length + keys({ archived: false }).length);
});
```

**Check.** The harness passes today (1/1). The UI part is verified in the browser with a disposable workspace. Create enough flags for two pages, archive one, open page 2, then switch to Archived: you should see page 1 with exactly one row. Switch back to Active and the archived flag is gone. Typing in the search box while Archived is selected composes with the filter. Changing the filter sends no POST, PATCH or DELETE (check the Network panel).

## 9. Should flag keys be unique per project or globally? (design + test)

**Goal.** Decide the uniqueness scope of flag keys and defend the decision.

**Hints.** `assertUniqueFlagKey` (`services.js:249-254`) scans *every* project's flags. SDK evaluation is already scoped to one project and environment through the token (`services.js:1648-1649`), and snapshots contain only that project's flags (`src/core/snapshot.js:51-52`). The 409 message names the key, which tells a member of project B that a key exists somewhere else.

Save as `test/practice-09-flag-key-scope.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { serviceFixture } from "./fixtures.js";

function withSecondProject(state) {
  const development = state.environments.find((item) => item.key === "development");
  state.projects.push({ id: "prj_second", key: "second", name: "Second", description: "",
    ownerUserId: state.users[0].id, createdAt: null, updatedAt: null });
  state.projectEnvironments.push({ id: "pe_second", projectId: "prj_second",
    environmentId: development.id, defaultStrategy: { type: "disabled", name: "Default",
    parameters: {}, constraints: [] }, createdAt: null });
}

test("flag keys are unique across every project, not per project", (t) => {
  const { service, admin } = serviceFixture(t, withSecondProject);
  assert.throws(
    () => service.createFlag(admin, { name: "Same key", key: "checkout_redesign",
      type: "release", projectId: "prj_second" }),
    { status: 409, message: 'Flag key "checkout_redesign" already exists' },
  );
});
```

**Check.** 1/1 pass today. If you choose per-project keys, change the test to expect success, pass `projectId` into `assertUniqueFlagKey` from both `createFlag` (847) and `updateFlag` (924), and add a test that a duplicate key *within* one project is still 409. Either way, write one paragraph on what the metrics summary and the audit log would need if two projects shared a key.

## 10. Make a delete refusal easier to resolve (design + implement)

**Goal.** When a segment cannot be deleted (`services.js:1912-1919`, 409 "Detach this segment from strategies before deleting it"), help an *authorized* administrator find the blocking strategies without exposing other projects.

**Hints.** Choose between a structured error detail (`createError` already accepts `details`, `services.js:21-26`, but the error handler at `router.js:438-446` serializes only `error` and `requestId`, so the details never reach the client today) and a separate dependency-inspection endpoint. A global segment (`projectId: null`) can be referenced from several projects. Authorize every identifier you return, not just the segment.

**Check.** Write a `serviceFixture` test with four assertions. (a) An authorized member receives the blocking strategy ids. (b) A user who cannot read the referencing project receives only the generic 409. (c) Deletion still fails while the segment is referenced. (d) After `updateStrategy(..., { segmentIds: [], confirmation })`, deletion succeeds and `auditLogs` gains a `segment.deleted` entry.

## 11. Move one resource to per-record versions (design, hard)

**Goal.** Stop unrelated edits from conflicting. Today any accepted write bumps the one workspace revision (03-WORKED-CHANGE §3). Move flags alone to per-record versions in a SQL table:

```sql
CREATE TABLE flags (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, UNIQUE (key));
UPDATE flags SET body = @body, version = version + 1 WHERE id = @id AND version = @expected;  -- changes: 1 accepted, 0 stale
```

**Hints.** `If-Match` would carry the flag's version, and `changes === 0` maps to the same 409 body as today. The `UNIQUE (key)` mirrors today's global rule. Change it if your exercise 9 decision differs.

**Check.** A written design plus a test plan containing these three cases: two users editing two different flags no longer conflict; two users editing the same flag still do; and the audit row records the accepted version. End with a paragraph on what you lose. Cross-record invariants such as "a strategy's segment still exists" or `detectDependencyCycle` (`services.js:354-385`) are no longer guarded by one revision. They need their own check inside a transaction at a suitable isolation level.

## 12. Design durable creation receipts (design, hard)

**Goal.** Today the UI blocks writes after an uncertain response (`src/ui/app.js:180-188`, `1198-1199`), but nothing stops a manual retry from creating a duplicate. Design an idempotency protocol for flag creation.

**Hints.** Define a client request id, its actor and project scope, a payload fingerprint, the stored response identity, a retention policy, and the behavior when an id is reused with a different payload. The receipt must be written in the same `mutate` draft as the flag and its audit entry. A memory-only map does not survive a restart.

**Check.** A failure matrix that covers four cases. (a) The same request replayed after a restart returns the original flag id. (b) A changed payload with the same id is refused. (c) Another actor cannot read the receipt. (d) An injected `renameSync` failure (reuse the `fsImpl` seam from `test/storage.test.js:60`) creates neither the flag nor the receipt. Also explain why token creation (`createToken`, `services.js:1401`) needs a different policy, given that its plaintext is shown once and never stored.

## 13. Plan a relational persistence migration (design, hard)

**Goal.** Map the 19 collections listed in `COLLECTIONS` (`src/server/storage.js:12-32`) to tables, keys, unique constraints, indexes and transaction boundaries. Choose a small vertical slice (projects + flags + featureFlagEnvironments), but account for audit history and revision checks.

**Hints.** Use the ownership/reference table in 01-CODEBASE-MAP to decide between `ON DELETE CASCADE` and `RESTRICT`. Protected-environment confirmation stays an application rule, because no foreign key can express a user's acknowledgment.

**Check.** A relationship diagram, two representative queries (the snapshot compile and the flag list), a backup/validate/import-once/compare plan with rollback, and test cases for duplicates, missing references and an interrupted import. State what replaces the lock-file lease. A design with an import experiment on synthetic data from `buildSeedState()` (`src/server/defaults.js:13`) is worth more than a rushed rewrite.
