# Worked changes: durable CRUD and context-safe evaluation

This chapter follows two actual defects from the original implementation through their fixes. Read the linked source alongside the examples. The purpose is to learn how to choose the correct invariant, reproduce a failure, and place the fix at the boundary that owns it.

## 1. Define what an accepted write means

The [original store](../docs/original/src/server/store.js) cloned state, ran a mutator, replaced the in-memory state, cleared its snapshot cache, and then wrote the JSON file directly. Imagine changing a project's name from `Checkout` to `Checkout training`. If writing failed because the file could not be replaced, the process could still hold the new name while the disk held the old name or an incomplete file. A response error alone would not repair that disagreement.

The invariant is: **a successful mutation publishes the same accepted representation to readers and to disk; a failed pre-replacement mutation preserves the previous accepted file.** This is more precise than saying “add error handling.” A `try/catch` around a direct write does not provide atomic replacement, and returning the old name after an error does not necessarily restore a partially written file.

The new [storage boundary](../src/server/storage.js) follows this sequence:

1. Obtain an exclusive writer lease for the configured file.
2. Read the current accepted file and compare its revision and byte digest with the operation's starting state.
3. Clone that state and run a synchronous mutation against the private draft.
4. Validate the draft and serialize it within the file-size limit.
5. Create a unique temporary file in the same directory, write it, flush it, and close it.
6. Replace the accepted file, then publish the exact serialized representation in memory.
7. Release only the lease created by this operation.

The temporary file is placed next to the accepted file so replacement stays on the same filesystem. The lease stops cooperating writers from performing the read/compare/replace sequence simultaneously. A revision check alone is insufficient if two writers can both observe revision 4 before either commits revision 5.

The implementation does not claim distributed database behavior or universal power-loss durability. A killed process can leave its lease or temporary file behind. Recovery should preserve evidence and establish which process owns the workspace; the application does not guess that another writer is dead.

## 2. Turn the failure into a behavioral test

Open [storage.test.js](../test/storage.test.js) and find the injected replacement failure. The fixture supplies an `fsImpl` object whose `renameSync` throws only after successful setup. This keeps the experiment away from your actual project data while exercising the real mutation path.

The important assertions inspect consequences:

```js
const before = fs.readFileSync(file);
assert.throws(() => store.mutate((draft) => {
  draft.projects[0].name = "Not accepted";
}));
assert.deepEqual(fs.readFileSync(file), before);
assert.equal(store.getState().projects[0].name, accepted.projects[0].name);
```

The actual test also checks that no operation-owned temporary file remains. If it asserted only that an exception was thrown, it would miss the original disagreement between memory and disk. Notice that the failure is injected at a real boundary, not by replacing the entire store with a function that always succeeds.

## 3. Carry the revision into the HTTP contract

Atomic persistence protects files. It does not tell the server whether a person edited an old form. That requires a precondition supplied by the client. Administration bootstrap includes a workspace `revision`; administrative writes send its strong ETag form in `If-Match`.

For example, two editors both load revision 12. One submits:

```http
PATCH /api/admin/projects/prj_example
Authorization: Bearer <your local personal token>
Content-Type: application/json
If-Match: "12"

{"name":"Checkout training"}
```

After that write commits, another request carrying `If-Match: "12"` receives a conflict. A client should retain its draft and show the latest accepted record for review. It should not replace the header with the newest revision and resubmit automatically: doing so would make the precondition meaningless.

This application uses a workspace-wide revision because the JSON file is its transaction boundary. An unrelated accepted configuration change can therefore cause a conflict. That is a deliberate cost of this small persistence model. A database implementation could introduce per-record versions, while still checking cross-record invariants inside a transaction.

Read `runRequest` in the store and [the HTTP server](../src/server/server.js). Request-local state stays consistent across `await` boundaries. The explicit client revision remains the expected write revision even when the server can read newer data. Otherwise, a fresh internal read could accidentally erase evidence that the submitted form was stale.

## 4. Find the wrong cache identity

The second defect lived in evaluation. The [original server SDK](../docs/original/sdk/server-sdk.js) retained one ETag and one result array. The service compared that ETag with the configuration snapshot before reading the next request's user context.

Consider a rule that enables checkout for `plan: "pro"`. Request A evaluates a pro user and receives `enabled: true`. Request B evaluates a free user against the same unchanged configuration. Reusing A's result because the configuration has not changed gives B the wrong answer.

The missing input is the context. Configuration identity and evaluation-result identity are different. The chosen fix is straightforward: keep compiled configuration snapshots cached, but evaluate every submitted context. The [server SDK](../sdk/server-sdk.js) no longer sends a configuration conditional header, and the service does not answer evaluation POSTs with 304.

The [regression tests](../test/context-cache.test.js) prove that a pro user's result and a free user's result differ even when the snapshot ETag is unchanged. A second regression changes debug mode without changing configuration, because debug mode also affects the response representation.

## 5. Handle asynchronous browser state separately

Fresh server evaluation does not solve browser response ordering. Suppose request A starts, request B starts, B finishes, and A finishes last. The [browser SDK](../sdk/browser-sdk.js) assigns each request a sequence number. Each caller receives its own result, but only the latest requested context may publish shared browser state.

The SDK also clears previous flags while a new context loads or fails, and `clear()` prevents an outstanding request from republishing after sign-out. Returned maps and nested variants are copies, so a subscriber cannot modify the accepted state seen by another subscriber. [SDK tests](../test/sdk.test.js) control promise completion order instead of depending on arbitrary sleeps.

Try explaining these fixes without using the word “cache” as a catch-all. Identify the accepted file, the editable draft, the configuration snapshot, the result for one context, and the result currently published to the browser. Each has a different owner and a different condition for becoming current. That distinction is useful in ordinary CRUD applications with optimistic updates, search requests, profile switching, and background refreshes.
