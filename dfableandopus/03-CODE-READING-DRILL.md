# Code reading drills: feature flag platform

Six drills for a live screen-share round. Give yourself ten minutes each and say your reasoning out loud before opening the answer.

## Drill 1: explain this function

`src/server/http-boundary.js:59-75`

```js
export function writeVersion(request, url) {
  const adminWrite =
    ["POST", "PATCH", "DELETE"].includes(request.method) &&
    url.pathname.startsWith("/api/admin/") &&
    url.pathname !== "/api/admin/playground";
  if (!adminWrite) return undefined;
  const value = request.headers["if-match"];
  if (typeof value !== "string" || !/^"[1-9][0-9]{0,15}"$/.test(value))
    throw httpError(
      428,
      'Supply the reviewed workspace version as If-Match: "1"',
    );
  const version = Number(value.slice(1, -1));
  if (!Number.isSafeInteger(version))
    throw httpError(428, "Invalid workspace version");
  return version;
}
```

Questions: what is the return value used for, why does the regex forbid a leading zero, and why is `/api/admin/playground` carved out?

<details>
<summary>Answer</summary>

The return value becomes the expected write version threaded into `store.runRequest` and consumed by `mutate` as `request.expectedVersion` (`src/server/storage.js:281-288`). It is the caller's statement of which workspace revision they reviewed.

The regex `/^"[1-9][0-9]{0,15}"$/` requires the strong ETag quotes and a canonical decimal with no leading zero, so `"007"` and `"12"` cannot both name revision 12. Sixteen digits keeps the parse inside safe-integer range, and the redundant `Number.isSafeInteger` check afterwards is defence in depth.

The playground route is excluded because it evaluates a hypothetical context and does not mutate state. Demanding a reviewed revision for a read-shaped operation would be ceremony with no invariant behind it.

Bonus point in an interview: note that 428 is used for both "no precondition" and "unparseable precondition", while a stale but well-formed precondition returns 409 from storage. That split is deliberate.
</details>

## Drill 2: spot the bug

The excerpt below is a **mutated** copy of `#commit` from `src/server/storage.js:228-260`. One change breaks a documented invariant. Find it.

```js
  #commit(candidate) {
    validateState(candidate);
    const bytes = Buffer.from(
      JSON.stringify(candidate, null, 2) + "\n",
      "utf8",
    );
    if (bytes.length > MAX_STATE_BYTES)
      throw storageError(422, "State exceeds 16 MiB; archive data before retrying");
    const temporary = `${this.dataFilePath}.${crypto.randomUUID()}.tmp`;
    let handle;
    let created = false;
    try {
      handle = this.io.openSync(temporary, "wx", 0o600);
      created = true;
      this.io.writeFileSync(handle, bytes);
      this.io.fsyncSync(handle);
      this.io.closeSync(handle);
      handle = undefined;
      const published = this.#accept({
        state: JSON.parse(bytes.toString("utf8")),
        digest: crypto.createHash("sha256").update(bytes).digest("hex"),
      });
      this.io.renameSync(temporary, this.dataFilePath);
      created = false;
      return published;
    } finally {
      if (handle !== undefined) this.io.closeSync(handle);
      if (created) this.io.unlinkSync(temporary);
    }
  }
```

<details>
<summary>Answer</summary>

`#accept` has been moved above `renameSync`. In the real code the publish happens only after the rename returns (`src/server/storage.js:249-255`), with the comment "Publish only after successful replacement, using the exact JSON representation."

The mutation reintroduces exactly the original defect the fix existed to remove: if `renameSync` throws, memory now holds the new state and the digest of bytes that were never accepted, while the file on disk still holds the old state. Worse than the original, because `#digest` now matches nothing on disk, so the next `mutate` digest comparison at `src/server/storage.js:292-295` will reject a legitimate write.

The test that catches it is `test/storage.test.js:60`, which asserts both that the disk bytes are unchanged and that `store.getState()` still returns the pre-mutation value.
</details>

## Drill 3: spot the bug

A **mutated** copy of `assertVariantWeights` (`src/server/services.js:312-339`), trimmed to the parts that matter:

```js
function assertVariantWeights(variants = []) {
  if (variants.length === 0) {
    return;
  }
  assert(
    variants.every(
      (variant) =>
        Number.isInteger(variant.weight) &&
        variant.weight >= 0 &&
        variant.weight <= 100,
    ),
    422,
    "Variant weights must be integers from 0 to 100",
  );
  assert(
    new Set(variants.map((variant) => variant.name)).size === variants.length,
    409,
    "Variant names must be unique within the strategy",
  );
  const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
  assert(total <= 100, 400, "Variant weights must sum to 100");
}
```

<details>
<summary>Answer</summary>

Two things. The stickiness check is gone, and the total comparison became `total <= 100` where the real code is `total === 100` (`src/server/services.js:338`).

`total <= 100` accepts a strategy whose variants sum to 60. Forty percent of matching users then fall into a hole: the weights no longer partition the space, and which variant they receive depends on how `pickVariant` walks the list rather than on a stated rule. A sum check is only meaningful as equality.

The missing check is the one at `src/server/services.js:331-336`, which rejects with 422 when variants in a single strategy use more than one stickiness field. Without it, two variants of the same strategy would bucket the same user on different identities, so the assignment stops being stable for that user, which is the whole point of stickiness.
</details>

## Drill 4: predict the status code

The workspace is at revision 12. Two administrators load the same flag page. Administrator A sends:

```http
PATCH /api/admin/projects/prj_example HTTP/1.1
Host: 127.0.0.1:8080
Authorization: Bearer <personal token with write scope>
Content-Type: application/json
If-Match: "12"

{"name":"Checkout training"}
```

It succeeds. Administrator B then sends the identical request, also with `If-Match: "12"`. Then administrator B retries with no `If-Match` header at all. Then a third request arrives with `If-Match: "12"` but from a token whose user is not a member of that project.

Give the status code for each of the four requests, and say which layer produced it.

<details>
<summary>Answer</summary>

1. **200.** Accepted; the workspace revision becomes 13 (`src/server/storage.js:308-313`).
2. **409.** `mutate` re-reads inside the lease, sees `meta.version` of 13 against an expected 12, calls `#accept` on the fresh read and throws `State changed; reload and review before saving` (`src/server/storage.js:292-300`). Produced by the storage layer, not the HTTP layer.
3. **428**, with the message `Supply the reviewed workspace version as If-Match: "1"` (`src/server/http-boundary.js:66-70`). Produced by the HTTP boundary before the router ever sees the body. Note that this fails earlier than case 2, so a request that is both stale and precondition-less reports 428.
4. **403**, `Project write access denied`, from `requireProjectWrite` (`src/server/services.js:187-195`) once `canWriteProject` returns false. Authorization runs in the service before `store.mutate`, so no lease is taken and no revision is consumed.

Follow-up worth volunteering: case 2 can also fire when the conflicting change was to a completely unrelated project, because the revision is workspace-wide.
</details>

## Drill 5: predict the output

`bucketValue` (`src/core/hash.js:15-19`) and `matchGradualRollout` (`src/core/evaluation.js:167-191`):

```js
export function bucketValue(input, range = 100) {
  const digest = stableHash(input);
  const numeric = Number.parseInt(digest.slice(0, 12), 16);
  return (numeric % range) + 1;
}
```

A flag `checkout_redesign` has one `gradual_rollout` strategy with `parameters: { rollout: 25 }` and no `groupId`. Answer these:

1. What string is hashed for a context `{ userId: "u_17" }`?
2. Is the decision stable across server restarts? Across a rename of the flag's `name` field? Across a change of the flag's `key`?
3. What happens for a context with no `userId`?
4. Can `bucketValue` ever return 0?

<details>
<summary>Answer</summary>

1. `checkout_redesign:u_17`. `groupId` defaults to `flagKey` (`src/core/evaluation.js:181`) and the stickiness field defaults to `userId` (line 171), so the hashed input is `${groupId}:${stickinessValue}` (line 182).
2. Stable across restarts, because nothing is stored: the bucket is recomputed from a SHA-256 of that string every time. Stable across a `name` change, because the name is not an input. **Not** stable across a `key` change: changing the key changes the hashed string, so the entire population is rebucketed. That is a real operational hazard and a good thing to say unprompted. Setting an explicit `groupId` decouples the cohort from the key and also lets two flags share one cohort.
3. `ownValue` returns nothing, `identity(stickinessValue)` is false, and the result is `{ matched: false, reason: 'Missing stickiness field "userId"' }` (`src/core/evaluation.js:174-179`). It fails closed, it does not default to enabled, and it reports why.
4. No. The return is `(numeric % range) + 1`, so the range is 1 to 100 inclusive. That matters because the comparison is `bucket <= rollout` (line 184): with a 0-based bucket, a rollout of 0 would still enable one percent of users.
</details>

## Drill 6: review this diff

A teammate proposes this change to make stuck leases self-healing. Find the defects.

```diff
   #withLease(operation) {
     let handle;
     try {
       handle = this.io.openSync(this.lockPath, "wx", 0o600);
     } catch (error) {
-      if (error.code === "EEXIST")
-        throw storageError(
-          503,
-          "Another writer owns the state lease; retry later",
-        );
+      if (error.code === "EEXIST") {
+        const info = JSON.parse(this.io.readFileSync(this.lockPath, "utf8"));
+        if (Date.now() - Date.parse(info.createdAt) > 5000) {
+          this.io.unlinkSync(this.lockPath);
+          handle = this.io.openSync(this.lockPath, "wx", 0o600);
+        } else {
+          throw storageError(503, "Another writer owns the state lease; retry later");
+        }
+      }
       throw error;
     }
```

<details>
<summary>Answer</summary>

Three defects.

**1. It steals the lease.** A five-second age is not evidence that the owning process is dead; it is evidence that a write is slow. Two processes then run the read/compare/replace sequence of `mutate` (`src/server/storage.js:289-317`) at the same time, which is precisely the race the lease exists to prevent. The digest check reduces the damage but does not remove it, because both writers can pass the check before either renames. The project's stated position is that a lease is never stolen, and there is a test for it: `existing writer lease is never stolen or removed` at `test/storage.test.js:139`. It also deletes evidence a human would need during recovery.

**2. Control flow bug: `throw error` still runs.** On the success path of the recovery branch, the code falls through to the unconditional `throw error` at the end of the catch block, so the freshly opened handle is leaked and the caller sees the raw `EEXIST`. The branch needed an early continuation, and the original code only reached `throw error` because the `EEXIST` case always threw first.

**3. Unguarded parse of an attacker- or crash-controlled file.** `JSON.parse(readFileSync(...))` throws if the lock file is empty or truncated, which is exactly the state a crashed writer can leave it in, since the lock is opened and written in two steps (`src/server/storage.js:203-220`). A `SyntaxError` with no `status` escapes as a 500 rather than the 503 that tells the caller to retry. `Date.parse` on a missing or garbage `createdAt` yields `NaN`, and `Date.now() - NaN > 5000` is false, so a corrupt lock file becomes permanently unrecoverable rather than reported.

The honest fix is not in this function at all: leave `#withLease` refusing, and document a human recovery procedure that identifies the owning pid, confirms it is not running, removes the lock and proves a write succeeds.
</details>
