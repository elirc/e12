# Worked changes: durable CRUD and context-safe evaluation

This chapter follows two real defects from the original implementation through to their fixes. The originals are preserved under `docs/original/` (comparison material only, not runnable). For each defect you will choose the correct invariant, reproduce the failure, and put the fix at the boundary that owns it.

## 1. Define what an accepted write means

This is the original store's write path:

```js
// docs/original/src/server/store.js:41-54
persist() {
  fs.writeFileSync(this.dataFilePath, JSON.stringify(this.state, null, 2));
}

mutate(mutator) {
  const draft = structuredClone(this.getState());
  const result = mutator(draft);
  draft.meta.version += 1;
  draft.meta.updatedAt = new Date().toISOString();
  this.state = draft;
  this.snapshotCache.clear();
  this.persist();
  return result;
}
```

Look at the order. `this.state = draft` publishes the change to every reader *before* `persist()` runs. Suppose you rename a project from `Checkout` to `Checkout training` and `writeFileSync` throws (disk full, file locked by an editor or antivirus). The caller gets an error, yet the process keeps serving the new name while the disk holds the old name, or a truncated file. `writeFileSync` writes in place, so a crash mid-write can leave invalid JSON that the next start cannot parse. There is also no version check: two writers simply overwrite each other.

The invariant: **a successful mutation publishes the same accepted representation to readers and to disk; a failed mutation leaves the previous accepted file and memory untouched.** That is more precise than "add error handling". A `try/catch` around `writeFileSync` cannot make an in-place write atomic, and restoring `this.state` in the catch does not repair a half-written file.

The new [storage boundary](../src/server/storage.js) follows this sequence. Each step is cited.

1. Obtain an exclusive writer lease: `openSync(lockPath, "wx")`, with `EEXIST` mapped to 503 (`#withLease`, 200-211).
2. Re-read the accepted file and compare its revision *and* SHA-256 digest with the operation's starting state. A mismatch is 409 (`mutate`, 290-301).
3. `structuredClone` the state and run the synchronous mutator on the private draft. An async mutator is refused (302-305).
4. Bump `meta.version`, then validate and serialize the draft within the 16 MiB limit (306-315, `#commit` 229-238).
5. Create a unique `<file>.<uuid>.tmp` in the same directory, write it, `fsync` it and close it (239-248).
6. `renameSync` the temp file over the accepted file, *then* publish the exact serialized bytes in memory (249-255).
7. In `finally`, remove the temp file if the rename never happened, and release the lease (256-259, 222-225).

The temp file lives next to the accepted file so the rename stays on one filesystem. The lease stops cooperating writers from running the read/compare/replace sequence at the same time. A revision check alone is not enough if two writers can both observe revision 4 before either commits revision 5.

The implementation does not claim distributed-database behavior or universal power-loss durability. A killed process can leave its lease file or temp file behind. Recovery should preserve evidence and establish who owns the workspace. The application never assumes another writer is dead (04-TESTING-AND-DEBUGGING has the manual procedure).

## 2. Turn the failure into a behavioral test

The store accepts an `fsImpl` seam (`storage.js:120-127`). The test injects a `renameSync` that throws only after setup has succeeded, so the real mutation path runs against a throwaway directory:

```js
// test/storage.test.js:60-87
test("failed replacement preserves accepted disk and memory state and cleans temporary files", (t) => {
  let fail = false;
  const { store, file, directory } = fixture(t, {
    fsImpl: {
      ...fs,
      renameSync: (...args) => {
        if (fail)
          throw Object.assign(new Error("Injected replace failure"), {
            code: "EACCES",
          });
        return fs.renameSync(...args);
      },
    },
  });
  const before = fs.readFileSync(file);
  const accepted = store.getState();
  fail = true;
  assert.throws(
    () =>
      store.mutate((draft) => {
        draft.projects[0].name = "Not accepted";
      }),
    /Injected/,
  );
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(store.getState().projects[0].name, accepted.projects[0].name);
  assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
});
```

Each assertion checks a consequence. Disk bytes are unchanged (84). Memory still holds the accepted name (85). The directory listing proves that neither the `.tmp` file nor the `.lock` file survived (86). A test that only asserted "it threw" would pass against the original store too, because `writeFileSync` throwing also throws. The failure is injected at a real boundary. The store is not replaced by a fake that always succeeds.

Run it on its own with `node --test --test-name-pattern="failed replacement" test/storage.test.js`.

## 3. Carry the revision into the HTTP contract

Atomic persistence protects files. It does not tell the server whether a person was editing an old form. That needs a precondition from the client. `GET /api/admin/bootstrap` returns `revision` (`src/server/router.js:79-98`). Every response carries `ETag: "<revision>"` (router.js 12-14). Administrative writes must echo the revision in `If-Match`, or they get 428 (`writeVersion`, `src/server/http-boundary.js:59-75`; `/api/admin/playground` is exempt because it does not write).

For example, two editors both load revision 12. One submits:

```http
PATCH /api/admin/projects/prj_example
Authorization: Bearer <your local personal token>
Content-Type: application/json
If-Match: "12"

{"name":"Checkout training"}
```

After that write commits, the second request with `If-Match: "12"` reaches `mutate` with `expectedVersion` 12 while the file says 13, and receives 409. The UI then sets `needsReview` (`src/ui/app.js:1198-1199`), keeps the draft, and offers the latest accepted record. It does not swap in the newest revision and resubmit automatically. Doing that would make the precondition meaningless.

`server.js` passes the parsed `If-Match` value into `store.runRequest(expectedVersion, ...)` (`src/server/server.js:43-44`). `mutate` prefers that request-level value over a fresh read (`storage.js:281-284`). If the server substituted a newer version it had just read, a stale form would silently become "current" and the conflict evidence would be lost. `test/storage.test.js:287` ("an explicit request version is not replaced by a newer read") pins this behavior.

The revision is workspace-wide because the JSON file is the transaction boundary. An unrelated accepted change can therefore cause a conflict. That is a deliberate cost of this persistence model.

## 4. Find the wrong cache identity

The second defect lived in evaluation. The original server SDK kept one ETag and one result array per client instance:

```js
// docs/original/sdk/server-sdk.js:16, 21-23
...(this.etag ? { "If-None-Match": this.etag } : {}),
// ...
if (response.status === 304) {
  return this.cachedFlags;
}
```

and the original service answered 304 *before* looking at the context:

```js
// docs/original/src/server/services.js:970-975
const ifNoneMatch = headers["if-none-match"];
if (ifNoneMatch && ifNoneMatch === snapshot.etag) {
  return { notModified: true, etag: snapshot.etag };
}

const results = evaluateSnapshot(snapshot, body.context ?? {});
```

The snapshot ETag is `W/"<project>-<environment>-<version>"` (`src/core/snapshot.js:68`). It identifies configuration only. In the seed data, user `d` with `plan: "pro"` is inside the 25% rollout, and user `a` with `plan: "pro"` is not (02-CONCEPTS has the table). If the same SDK instance evaluates `d` and then `a`, the second call sends the ETag from the first, gets 304, and returns `d`'s flags for `a`.

The missing cache input is the context, and the debug flag as well, because it changes the response shape. The chosen fix is simple: keep caching compiled configuration snapshots (`storage.js:320-338`), but evaluate every submitted context. The current `evaluateClient` has a comment at the spot where the 304 used to be (`src/server/services.js:1654-1656`). It always returns `notModified: false`, and both evaluate routes send `Cache-Control: no-store` (router.js 402-412). The current [server SDK](../sdk/server-sdk.js) sends no conditional header, and `sdk/request.js:47-48` treats any non-200 status, 304 included, as an error.

The [regression tests](../test/context-cache.test.js) send the first response's ETag back as `if-none-match` and assert that the second user still gets their own answer (line 23). The second test changes only `debug` (line 44).

## 5. Handle asynchronous browser state separately

Fresh server evaluation does not solve the order in which responses arrive. Request A starts, request B starts, B finishes, A finishes last. The [browser SDK](../sdk/browser-sdk.js) numbers each refresh:

```js
// sdk/browser-sdk.js:36-49
async refresh(context = {}) {
  const sequence = ++this.#sequence;
  // Do not expose the prior identity's flags while a different context loads.
  this.#flags = new Map();
  this.notify();
  const flags = await this.request("/api/client/features", context);
  const result = new Map(flags.map((flag) => [flag.key, flag]));
  if (sequence === this.#sequence) {
    this.#flags = result;
    this.notify();
  }
  // The caller gets its own request result; only the latest request publishes.
  return structuredClone(result);
}
```

`clear()` (51-55) also increments the sequence, so a request still in flight at sign-out cannot republish afterwards. `get` and `flags` return `structuredClone` copies (13-15, 57-61), so a subscriber cannot mutate state that another subscriber sees. [SDK tests](../test/sdk.test.js) (line 55 onward) control the order in which promises resolve instead of relying on sleeps. Practice exercise 6 has you write one yourself.

Try explaining these fixes without using "cache" as a catch-all word. Name the accepted file, the editable draft, the configuration snapshot, the result for one context, and the result currently published to the browser. Each has a different owner and a different condition for becoming current. The same distinction applies to optimistic updates, search-as-you-type, profile switching and background refresh in ordinary CRUD apps.
