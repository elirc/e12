# Interview questions: feature flag platform

Every technical answer below cites a file and line you can open. Levels are marked junior or mid.

## Screening

### S1. Walk me through the data model. (junior)

Nineteen collections live in one JSON document; the authoritative list is `COLLECTIONS` in `src/server/storage.js:12-32`. The spine is `projects` -> `projectEnvironments` -> `featureFlags` -> `featureFlagEnvironments` -> `strategies` -> `variants`. `segments` and `segmentConstraints` are reusable targeting rules that may be project-scoped or global: `compileSnapshot` accepts a segment when `segment.projectId === null || segment.projectId === projectId` (`src/core/snapshot.js:21-23`). `apiTokens`, `projectMembers`, `auditLogs`, `flagDependencies` and `metricsImpressions` hang off the side. Every record needs a unique string `id` of at most 128 characters, enforced per collection in `validateState` (`src/server/storage.js:86-107`).

### S2. What is the request path for an administrative write? (junior)

`validateRequest` checks host, URL shape, method and cross-origin headers (`src/server/http-boundary.js:22-57`); `writeVersion` extracts the `If-Match` precondition (`src/server/http-boundary.js:59-75`); `readJsonBody` caps the body at 65536 bytes and runs `inspect` for depth, string length and prototype-poisoning field names (`src/server/http-boundary.js:106-167`); the router dispatches to a service method; the service checks scope and project membership; `store.mutate` takes the lease, re-reads, compares, clones, mutates, commits.

### S3. Which boundary validates, and why there? (mid)

Three boundaries with different jobs. `http-boundary.js` validates the transport: is this a well-formed, correctly sized, same-origin JSON request. `contracts.js` validates the shape of a resource, for example `validateStrategySettings` (`src/server/contracts.js:186-195`). `storage.js` `validateState` validates the persisted document shape and identity only, and says so in a comment at `src/server/storage.js:108-110`: relationships and authorization belong to the service layer. Putting relational checks in storage would make the store know about the domain; putting shape checks only in the service would let a hand-edited file poison memory.

### S4. What is `meta.version` and who bumps it? (junior)

One counter for the whole workspace. `mutate` sets `draft.meta.version = current.state.meta.version + 1` inside the lease (`src/server/storage.js:308-313`). It is the ETag clients send back in `If-Match`.

### S5. How is authentication separated from authorization? (junior)

Authentication is `getActorFromToken` matching a SHA-256 hash (`hashToken`, `src/core/hash.js:7-9`) against `apiTokens`; only the hash is stored. Authorization is three separate questions: token scope (`requireScope`, `src/server/services.js:115-121`), instance role (`requireAdminRole`, `src/server/services.js:123-133`) and project membership (`canWriteProject`, `src/server/services.js:158-175`). A token can carry `write` scope and still be refused because the user is not a member of that project.

### S6. What status code does a missing precondition produce, and why that one? (junior)

428 Precondition Required, with the message `Supply the reviewed workspace version as If-Match: "1"` (`src/server/http-boundary.js:66-70`). 428 means "you must send a precondition"; 412/409 means "your precondition failed". The stale case returns 409 from `src/server/storage.js:296-300`.

### S7. Why is the admin playground exempt from `If-Match`? (mid)

`writeVersion` treats a POST/PATCH/DELETE under `/api/admin/` as an admin write except `/api/admin/playground` (`src/server/http-boundary.js:60-64`). The playground evaluates a hypothetical context; it does not mutate state, so demanding a reviewed revision would be ceremony with no invariant behind it.

### S8. How does the app avoid returning stale evaluations? (mid)

Compiled configuration snapshots are cached by project, environment, version and digest (`getSnapshot`, `src/server/storage.js:320-338`), but the user context is evaluated on every request. The evaluate routes always return 200 with `Cache-Control: no-store` (`src/server/router.js:402-412`); there is no 304 path for evaluation.

## Deep dive

### D1. Describe the persistence bug you fixed and the invariant you chose. (mid)

The original store cloned state, ran the mutator, replaced in-memory state, cleared its snapshot cache and then wrote the file. If the write failed, memory held the new value and disk held the old or a truncated one. The invariant I wrote down: a successful mutation publishes the same accepted representation to readers and to disk, and a failed pre-replacement mutation leaves the previous accepted file untouched. "Add a try/catch" does not satisfy it. The fix is `#commit` (`src/server/storage.js:228-260`): serialize, write a uniquely named `.tmp` sibling, fsync, close, `renameSync` over the target, and only then call `#accept` with the exact bytes just written.

### D2. Why is the temporary file a sibling rather than in the OS temp directory? (mid)

`const temporary = ${this.dataFilePath}.${crypto.randomUUID()}.tmp` at `src/server/storage.js:239`. Rename is atomic only within a filesystem. A cross-device rename degrades to copy-then-delete, which reintroduces the partial-file window the fix exists to close.

### D3. A revision check is not enough. Why the lease? (mid)

Two writers can both read version 4 before either commits 5. `#withLease` opens the lock path with flag `wx` so creation fails if it exists, and maps `EEXIST` to 503 `Another writer owns the state lease; retry later` (`src/server/storage.js:200-211`). The read/compare/replace sequence happens inside that lease, in `mutate` at `src/server/storage.js:289-317`.

### D4. What breaks if we delete the digest comparison on line 294 of storage.js? (mid)

`mutate` refuses when `current.state.meta.version !== expectedVersion || (expectedDigest !== null && current.digest !== expectedDigest)` (`src/server/storage.js:292-295`). Remove the digest half and an external edit that keeps the same version number becomes invisible; the mutation is applied on top of a draft that no longer matches disk and the edit is silently lost. The regression that guards this is `same-version external edits are detected by their bytes` in `test/storage.test.js:124`.

### D5. Why does `#commit` re-parse its own bytes at line 253? (mid)

`this.#accept({ state: JSON.parse(bytes.toString("utf8")), digest: ... })`. The in-memory object published to readers is parsed from the exact bytes on disk, not from the draft. Any value that serialized differently, for example a `Date` becoming a string, would otherwise leave memory and disk disagreeing about types while the digest claims they agree.

### D6. The lease is released in a `finally`. What does that not protect against? (mid)

`finally { this.io.closeSync(handle); this.io.unlinkSync(this.lockPath); }` (`src/server/storage.js:222-225`) covers exceptions, not a killed process. A SIGKILL leaves the lock file, and every later write gets 503. The app deliberately does not steal it: `existing writer lease is never stolen or removed` is a test at `test/storage.test.js:139`. Recovery is a human procedure: confirm no live process holds the workspace, then remove the lock.

### D7. Explain the evaluation cache defect. (mid)

The original server SDK kept one ETag and one result array, and the service compared the configuration ETag before reading the request's user context. Request A for `plan: "pro"` returned enabled; request B for a free user reused A's result because the configuration had not changed. The identity of a configuration snapshot and the identity of an evaluation result are different keys; the missing input was the context. Fix: keep snapshot caching, drop the conditional response. Regression: `an unchanged configuration still evaluates each new user context` at `test/context-cache.test.js:23`, plus `request debug mode is evaluated even when configuration has not changed` at `test/context-cache.test.js:44`, because debug mode changes the response body without changing configuration.

### D8. How does a percentage rollout stay stable for the same user? (junior)

`matchGradualRollout` builds `bucketValue(${groupId}:${stickinessValue})` where `groupId` defaults to the flag key (`src/core/evaluation.js:181-182`). `bucketValue` hashes to hex, parses the first 12 characters base 16 and returns `(numeric % range) + 1`, so a bucket from 1 to 100 (`src/core/hash.js:15-19`). Same user, same flag, same bucket, no stored assignment. Missing stickiness field returns `matched: false` with a reason rather than defaulting to enabled (`src/core/evaluation.js:174-179`).

### D9. Variant weights: what is validated and with which codes? (mid)

`assertVariantWeights` (`src/server/services.js:312-339`) rejects non-integer or out-of-range weights with 422, duplicate names with 409, mixed stickiness fields with 422, and a total other than 100 with 400. Worth noting in an interview that the mix of 400 and 422 here is not perfectly consistent; I would standardise on 422 for semantic validation failures.

### D10. How does the protected-environment rule work, and why is UI state not enough? (mid)

`assertProtectedEnvironmentConfirmation` requires the literal token `CONFIRM:${environment.key}` in the request when `environment.protectChanges` is set, else 409 (`src/server/services.js:271-286`). `createFlag` calls it for every target environment before mutating (`src/server/services.js:868-873`). The UI resets the acknowledgment when a field changes because you are now reviewing a different draft, but the server enforces the rule independently, so a caller bypassing the UI is still refused.

## Behavioral

### B1. Tell me about a bug that was not what it first looked like. (mid)

Situation: evaluations returned the wrong answer for some users. Task: find out why without the word "cache" doing all the work. Action: I separated the five things people were calling a cache in this system - the accepted file, the editable draft, the compiled configuration snapshot, one context's result, and what the browser has published - and asked what makes each current. Only one of them, the per-context result, was keyed on something that did not include the context. Result: the conditional response was removed, snapshot caching kept, and two regressions added at `test/context-cache.test.js:23` and `:44`; the full backend suite is 98 passing cases.

### B2. Tell me about a time you chose a harder fix. (mid)

Situation: a failed file write left memory and disk disagreeing. Task: make an accepted write mean one thing. Action: rather than wrapping the write in try/catch, I wrote the invariant down first and then built the seven-step commit in `src/server/storage.js` around it, including a lease, a digest check and an atomic rename. Result: the failure is injected at the real boundary in `test/storage.test.js:60`, which asserts the file bytes are unchanged, memory still holds the old name, and no operation-owned temp file remains.

### B3. When did testing change your design? (junior)

Situation: I needed to prove a replacement failure was handled. Task: fail `renameSync` without touching real data. Action: the store takes an `fsImpl` in its constructor (`src/server/storage.js:120-127`), so the test supplies an fs object whose `renameSync` throws only after setup succeeds. Result: the injection point is a real seam, not a stubbed-out store, and the suite runs on Node's built-in test runner with no packages installed.

### B4. Tell me about a limitation you reported rather than hid. (mid)

Situation: the suite was green and someone could have read that as production readiness. Task: write down what green does not prove. Action: `astraupskill/VERIFICATION.md` states the local-JSON persistence limits, the killed-writer lease, JSON parsing not rejecting duplicate property names, the absence of idempotency receipts, and that browser selectors passing does not establish accessibility. Result: reviewers got an accurate picture, and the 20-workflow browser run that passed in 92.54 seconds is reported as coverage, not as proof.

### B5. Tell me about feedback that changed your work. (junior)

Situation: the first browser run failed on an invalid role in the test fixture. Task: decide whether the app or the fixture was wrong. Action: the authorization rules were correct; the fixture was using a role the system does not grant. I corrected the fixture. Result: I did not weaken `canWriteProject` to make a test pass, and that decision is recorded in `astraupskill/VERIFICATION.md`.

## Follow-ups an interviewer asks next

### F1. "You said the client should not retry with the new version. Why not?"

Auto-resubmitting with the latest revision makes the precondition meaningless: it converts optimistic concurrency into last-write-wins with extra round trips. The client should keep the draft, show the latest accepted record, and let a person decide.

### F2. "Workspace-wide revision means unrelated edits cause conflicts. Defend that."

It is a real cost, and I would not defend it for a multi-team production system. It is correct for this storage model because the whole JSON file is the transaction boundary; a per-record version would be a lie about what is actually being replaced. In Postgres I would put a `version` column on the row and check it in the `UPDATE ... WHERE id = $1 AND version = $2` predicate, while keeping cross-record invariants inside the transaction.

### F3. "Your lock is a file. What happens under two processes on a network share?"

The `wx` open is atomic on local filesystems; over NFS or SMB that guarantee is weaker and I would not claim it. This is a cooperating-writer lease for a single-machine tool, not a distributed lock. The real answer at scale is the database's own locking, or an advisory lock.

### F4. "You cap the body at 64 KiB. Is that the only size limit?"

No. `MAX_BODY_BYTES` is 65536 (`src/server/http-boundary.js:4`) and is checked twice, once against the declared `Content-Length` and once against streamed bytes (`src/server/http-boundary.js:127-160`). Separately, state is capped at 16 MiB (`MAX_STATE_BYTES`, `src/server/storage.js:8`), arrays at 2000 items and objects at 1000 fields. The known gap I would raise: SDK response bodies are parsed without a streaming byte cap.

### F5. "Why reject `__proto__` as a field name instead of just ignoring it?"

`inspect` throws 422 `Unsupported JSON field name` for `__proto__`, `constructor` and `prototype` (`src/server/http-boundary.js:96-100`). Silently dropping fields hides an attack and also hides a client bug. Rejecting is louder and cheaper to debug.

### F6. "Where would you add an index if this were a database?"

Today every lookup is a linear scan, for example `assertUniqueFlagKey` scanning `state.featureFlags` (`src/server/services.js:249-254`). In Postgres the first indexes are a unique index on flag key (global today, not per project), an index on `strategies.environment_id`, and a composite index on `(flag_id, environment_id)` for `featureFlagEnvironments`, because `compileSnapshot` filters strategies by environment alone (`src/core/snapshot.js:26-34`) and flag mappings by flag plus environment (`src/core/snapshot.js:51-58`).
