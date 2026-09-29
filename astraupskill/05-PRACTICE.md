# Practice assignments with acceptance criteria

Work in a disposable workspace and preserve your starting code. Each assignment should produce a small implementation, behavioral evidence, and a review description. Complete the first two before attempting the architecture exercises. These are proposed learner changes; their presence in this course does not mean they are already implemented.

## 6. Take `If-Match` to a per-record version column

This project's revision is workspace-wide: any accepted write bumps one number, so two people editing two different flags conflict with each other (03-WORKED-CHANGE §3 names the trade-off). Move one resource, flags, to per-record versions in a SQLite table:

```sql
CREATE TABLE flags (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, UNIQUE (project_id, key));
UPDATE flags SET body = @body, version = version + 1 WHERE id = @id AND project_id = @project AND version = @expected;  -- changes: 1 accepted, 0 stale
```

`If-Match` carries the flag's version instead of the workspace revision; the route maps `changes === 0` to the same 409 body the workspace revision produces today. Acceptance: two users editing two different flags no longer conflict (test it), two users editing the same flag still do, and the audit row still records the version that was accepted. Then write one paragraph on what you lost: cross-record invariants (a flag referencing a segment that was just deleted) are no longer protected by one revision and need their own check inside the transaction.

## 1. Explain and improve a validation error

Choose one invalid strategy configuration, such as a gradual rollout with `rollout: 101`. Reproduce the current rejection through the browser and through a service test. Improve the error so a learner understands the expected range and the field that failed. Keep the status and rejection behavior consistent. An acceptable submission proves 0 and 100 remain valid, 101 and a string value remain invalid, and rejected input changes neither accepted state nor audit history.

Read [contracts.js](../src/server/contracts.js) before editing. Do not add a browser-only rule and call the task complete. Explain why the server owns the invariant and why the UI may still provide a faster hint. Include a before/after error example in your review description.

## 2. Add an archive filter to the flag list

The current list searches names and keys and pages results. Add an explicit active/archived/all filter for flags. Define the default, whether the selection survives changing resource kind, and what happens to the current page when filtering reduces the result count. Preserve any open draft when the visible list changes. Use text and labeled controls rather than an unexplained icon.

Acceptance: create enough synthetic flags for two pages, archive one, filter to archived, and confirm the correct count and page. Return to active and verify that the archived record disappears. Search and filter must compose. A list filter must not change server authorization or expose another project's records. Extend the browser fixture only with synthetic records and add one meaningful workflow assertion.

## 3. Make delete refusal easier to resolve

Select a segment referenced by a strategy. The server refuses deletion. Design a response that helps an authorized administrator locate the blocking strategy without exposing unrelated projects. Decide whether to use a structured error detail or a separate dependency-inspection endpoint. Do not leak identifiers merely to make debugging convenient.

Acceptance: an authorized member can identify the blocker, an unrelated member cannot inspect it, deletion still fails while referenced, and removing the reference permits deletion. Review [services.js](../src/server/services.js) and its reference checks. Explain why a cascade would be inappropriate for this shared resource. Include how the UI retains its draft after the refusal.

## 4. Design durable creation receipts

The current UI requires review after an uncertain response. Design an idempotency protocol for flag creation. Define a client request identifier, actor/project scope, payload fingerprint, stored response identity, retention policy, and conflict behavior when an identifier is reused with a different payload. Store the receipt atomically with the created record and audit event. A memory-only map is insufficient across process restarts.

Acceptance: repeat the same accepted request after restarting the server and receive the original creation identity; a changed payload with the same identifier is refused; another actor cannot read the first actor's receipt; an injected pre-replacement failure creates neither flag nor receipt. Explain which one-time responses, especially token plaintext, require a different policy. This is an advanced assignment: write the design and failure matrix before implementing it.

## 5. Plan a relational persistence migration

Map the visible JSON collections to relational tables, keys, unique constraints, indexes, and transaction boundaries. Choose a small vertical slice, such as projects and flags, but account for mappings, audit history, and revision checks. Define how existing data is backed up, validated, imported once, and compared after migration. Avoid silently reseeding on failure.

Your review artifact should include a relationship diagram, two representative queries, a migration rollback plan, and tests for duplicates, missing references, and interrupted import. State how filesystem leases would be replaced by database transaction/concurrency behavior. Implementing a new database is optional; a precise design with an executable import experiment on synthetic data is more useful than a rushed rewrite that loses existing semantics.
