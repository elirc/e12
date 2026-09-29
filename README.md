# Feature Flag Platform

A dependency-light reference implementation of a multi-project feature flag platform.

## What is included

- Control plane APIs for projects, environments, flags, strategies, segments, variants, dependencies, tokens, dashboard, and audit logs
- Evaluation plane APIs backed by cached project/environment snapshots
- JSON persistence so the core data model stays visible and easy to inspect
- Labeled CRUD editors for eight resource types, project-scoped lists, search, pagination, retained drafts, protected-change acknowledgment, and audit history
- Reference browser and server SDKs
- Automated tests using Node's built-in test runner, plus an optional disposable Chromium workflow suite
- A detailed [nine-part junior-to-mid-level CRUD course](astraupskill/README.md) with worked changes, source links, exercises, solutions, and a trace lab

## Why this shape

The goal here is clarity over production polish. The codebase keeps the interesting parts visible:

- `src/core`: shared evaluation logic, hashing, constraints, variants, snapshot compilation
- `src/server`: persistence, RBAC/auth, APIs, metrics, audit logging, and static file hosting
- `src/ui`: dependency-free admin UI
- `sdk`: tiny reference SDKs
- `test`: focused tests for rollout and safety rules

## Quick start

Use Node 22 or newer. This project has no npm runtime dependencies. Tests create disposable data; they do not reset the application's state file.

```powershell
npm test
$env:FEATURE_FLAGS_DATA_FILE = Join-Path $PWD 'data\my-learning-workspace.json'
npm run setup -- owner "Your name" "you@example.com"
npm start
```

Save the newly generated personal token privately and enter it in the administration interface. Then open `http://127.0.0.1:3000`. The server binds to loopback. Keep `FEATURE_FLAGS_DATA_FILE` set to the same absolute path in any new terminal. Setup refuses to replace an existing file; subsequent starts need only `npm start`.

The original `data/state.json` remains available and is not overwritten by these instructions. If you intentionally choose an existing file through `FEATURE_FLAGS_DATA_FILE`, its existing users and tokens remain in effect. Changing the application code does not rotate old credentials.

For a disposable demonstration, choose a different, unused path and explicitly acknowledge its known credentials:

```powershell
$env:FEATURE_FLAGS_DATA_FILE = Join-Path $PWD 'data\disposable-demo.json'
npm run setup -- demo --acknowledge-local-only
npm start
```

## Seed tokens

These public fixture tokens belong to the explicit demo setup and the original demo dataset. Owner setup issues a fresh random token and excludes them. They are hashed in the state file.

- Admin PAT: `demo-instance-admin-token`
- Production client token: `demo-production-client-token`
- Development frontend token: `demo-development-frontend-token`

## Use the administration workspace

Connect explicitly with a personal token. The page keeps it in this tab's memory; it does not remember it across reloads. Choose a resource under Manage, select an existing record or New record, and use the labeled form. Advanced constraints, strategy parameters, defaults, and variant sets use JSON fields with examples. Invalid JSON retains the draft and identifies the field.

Project and environment creation and token administration require instance-administrator authority. Project members with a write scope can edit resources in writable memberships. The `viewer` instance role reads all projects but cannot write with its normal read-only token. The server enforces permission boundaries independently of disabled browser controls.

Every accepted mutation advances the workspace revision. A stale save keeps your draft and asks you to review the latest state. Only fields you changed are reapplied after review; unedited fields use the latest accepted values. Network failures and server write errors also require review because a missing success response does not prove that the change failed. There is no automatic mutation retry or durable creation-receipt protocol. If a token creation response is lost, inspect its metadata and revoke/recreate it as appropriate; its stored hash cannot recover the plaintext.

Protected configuration requires explicit acknowledgment. Editing another field resets that acknowledgment. A segment or dependency change can affect protected environments through its references. Deletion preserves audit history, refuses shared or retained references, and removes owned children where appropriate. Flags must be archived before deletion, and retained metrics or dependencies can still block removal. Existing tokens are revoked rather than erased.

## SDK example

Create a client evaluation token for the intended project and environment. Keep personal administrator tokens out of consuming applications. Save this example in a local module in the project root, provide its evaluation token through your environment, and run it with Node:

```js
import { FeatureFlagServerClient } from "./sdk/server-sdk.js";

const client = new FeatureFlagServerClient({
  baseUrl: "http://127.0.0.1:3000",
  token: process.env.FEATURE_FLAGS_EVALUATION_TOKEN,
  timeoutMs: 10000,
});
const flags = await client.evaluate({ userId: "learner-1", plan: "pro" });
const banner = flags.find((flag) => flag.key === "learning_banner");
console.log({ enabled: banner?.enabled ?? false });
```

Each SDK evaluation submits its context again. The browser SDK publishes only the latest requested context, clears prior decisions during refresh, and supports `clear()` when the consuming application's identity changes. A returned configuration ETag is diagnostic metadata, not a cached result for a different user. SDK imports are source modules for your consuming app; this server's static-file allowlist does not publish the SDK directory as browser assets.

## Verification and learning

Run `npm test` for the backend suite. No npm install is needed because there are no package dependencies. Optional browser checks use the separate Python requirements under `verification`, an installed Chromium, and a new output directory:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r verification/requirements-browser.txt
.\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\python.exe verification/verify_browser.py verification/browser-evidence-01
```

Alternatively set `ASTRA_BROWSER_EXECUTABLE` to an existing compatible Chromium executable. The browser fixture creates its own synthetic state and loopback server. See [verification details](astraupskill/VERIFICATION.md) for evidence interpretation and limits. The older `docs/onboarding` notes are retained as historical explanations; the new course describes the improved implementation.

## Notes

- Storage writes a same-directory temporary file, flushes and closes it, replaces the accepted file, and only then publishes state in memory. A writer lease and revision checks prevent cooperating writers from silently overwriting stale state. The 16 MiB file limit and schema checks fail without resetting data.
- A crashed writer can leave a `.lock` or `.tmp` file. Stop the process that owned this workspace and preserve a copy of all files before investigating. The application never guesses that a lease is stale or deletes another writer's lease. This is a local filesystem learning store, not a distributed database or a power-loss durability guarantee.
- Evaluation POST requests always evaluate their submitted context. The snapshot ETag identifies configuration, not a user's result. Both SDKs reject a 304 response; the browser SDK clears old flags during refresh and publishes only the newest requested context. Call `clear()` on sign-out. Subscriber exceptions are retained in `listenerErrors` (last ten) and do not stop other subscribers.

- The platform separates admin writes from evaluation by compiling and caching snapshots per project/environment.
- Multiple strategies on the same flag/environment use OR semantics.
- Segment updates affect every strategy that references them because the evaluator resolves segment constraints from snapshots.
- Dependencies are limited to the same project and cycle-checked before writes are accepted.
- Metrics ingestion validates an entire batch before writing, derives scope from its token, and retains at most 20,000 events. There is no automatic pruning or ingestion deduplication. Rate limits are process-local.
- Persisted-state validation checks basic shapes and identifiers; it is not a complete relational migration validator. JSON parsing accepts duplicate keys using normal JavaScript parsing, and date constraints use finite `Date.parse` results. SDK response parsing has no streaming byte cap.
- This remains a local learning application with no account-recovery workflow, distributed storage, live provider integration, or verified production deployment.
