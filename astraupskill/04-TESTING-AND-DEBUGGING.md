# Testing and debugging with observable consequences

Run `npm test` from the project root. [verification/run-tests.js](../verification/run-tests.js) reads `test/`, keeps only names ending in `.test.js`, sorts them, and runs `node --test` on that list. `fixtures.js`, `helpers.js` and the preserved originals under `docs/original` are never counted as tests. On 2026-10-06 the suite reported `# tests 98`, `# pass 98` in about 18 seconds on Node 22.16. A passing command is evidence for the cases it ran. It does not prove the interface was exercised or that the application is production-ready. Keep the command, the exit code, the test names and your Node version with your work.

Any file you add as `test/<name>.test.js` is picked up by `npm test` automatically. That is how the practice harnesses in 05-PRACTICE run. Remove or rename them before comparing your total with the 98 baseline.

## Choose the smallest useful reproduction

Focused runs are faster and keep the output readable:

```bash
node --test test/storage.test.js
node --test --test-name-pattern="stale edit" test/storage.test.js
```

| Symptom | Start in | Then read |
|---|---|---|
| An invalid weight or rollout is accepted | `test/contracts.test.js`, `test/crud.test.js` | `src/server/contracts.js:177-195`, `253-269`; `services.js:312-339` |
| The wrong project is visible or editable | `test/authorization.test.js` | `services.js:145-195`, the wrapper at `2017-2048` |
| A stale save overwrote accepted data | `test/http.test.js`, `test/storage.test.js:103` and `:287` | `http-boundary.js:59-75`, `storage.js:277-318` |
| A disk error left memory and file disagreeing | `test/storage.test.js:60` | `storage.js:228-260` |
| Two users got each other's flags | `test/context-cache.test.js`, `test/sdk.test.js` | `services.js:1641-1686`, `sdk/browser-sdk.js:36-49` |
| A rule matched a user who lacked the field | `test/evaluation-safety.test.js` | `src/core/evaluation.js:27-125` |

Use the real implementation through a small fixture rather than mocking away the behavior you need to verify. `serviceFixture(t, alter)` in `test/fixtures.js` gives you a real `PlatformStore` on a fresh temp file. Its `alter(state)` callback lets you add synthetic users, projects or tokens before the store is initialized.

A useful assertion checks accepted state as well as the response. For example, submit a metrics batch with one valid impression and one invalid one, assert the rejection, then read the store and assert that neither impression was appended. Expecting only an error would miss a partial-write defect. In the same way, a rejected flag edit should leave the flag's name, `meta.version` and `auditLogs.length` unchanged. Capture all three before the call and compare them after.

## Debug a stale edit

Open two tabs using a disposable workspace. Both load the same flag. In tab A, edit its name without saving. In tab B, edit its description and save. Return to A and save: expect a conflict. Inspect the request's `If-Match`, the response status, and the editor's retained name. Choose review latest; compare the latest accepted description and your changed name. Continue with the reviewed version. The resulting flag should contain both changes.

If the description returns to its old value, inspect `changes()` and `renderEditor(latest, draft)` in [app.js](../src/ui/app.js). Is the draft a complete old record or just changed fields? Did a form rebuild reset the baseline incorrectly? Write down which representation exists at each step before changing code. Randomly adding refreshes can hide a race while introducing lost drafts.

## Debug an uncertain creation

The browser verification script intercepts a creation response after the real local server accepts it, then aborts delivery to the page. This models “the request may have succeeded.” The expected behavior is one accepted record, one attempted POST, a retained draft, and blocked writes until review. Do not solve this by automatically submitting again. A durable idempotency design is a separate practice assignment with a larger storage contract.

## Recovering from a stuck lease

Writes take a lease by creating the lock file exclusively (`#withLease`, `src/server/storage.js:200-226`: `openSync(this.lockPath, "wx", 0o600)`). A crash between acquire and release leaves the file behind, and every later write answers 503 `Another writer owns the state lease; retry later`. Reads keep working, because only `mutate` and `initialize` take the lease.

1. **Identify the file.** It is `<state file>.lock`, set in the constructor at `storage.js:126` (`this.lockPath = \`${this.dataFilePath}.lock\``). Its contents are JSON `{"pid": ..., "createdAt": ...}`, written right after acquisition (213-219).
2. **Confirm nobody owns it.** Read the JSON; check the pid is not running (`Get-Process -Id <pid>` on Windows, `ps -p <pid>` elsewhere) and that the timestamp is older than any request that could still be in flight. If the pid is alive, do nothing: the lease is real.
3. **Remove it safely.** Stop the server, delete the lock file, start the server, and make one read request before any write. Never delete it while the server runs: a writer may be between acquire and release.
4. **Prove it.** The next write returns 200, and a new lease file appears and disappears around it. Practice exercise 5 runs this whole sequence in a test against a temp directory.

This procedure is how you deal with the limit VERIFICATION describes ("a killed writer can leave a lease"). One more way to strand a lease: in `#withLease`'s `finally` block, `closeSync` runs before `unlinkSync` (222-225). If closing the handle throws, the unlink never happens.

## Browser checks are optional development dependencies

Use a separate Python environment for [requirements-browser.txt](../verification/requirements-browser.txt), install its pinned package, and provide Chromium through `ASTRA_BROWSER_EXECUTABLE` or Playwright's browser installation. Run:

```powershell
python verification/verify_browser.py verification/browser-evidence-01
```

The evidence directory must be new. [browser-fixture.js](../verification/browser-fixture.js) creates synthetic users and records in a newly owned temporary directory, starts an ephemeral loopback port, and never opens the original dataset. The Python harness records passing workflow names, screenshots, failures, and elapsed time. Inspect the screenshots; successful selectors alone do not prove a usable layout.

## Read failures carefully

An earlier fixture accidentally shared a mutable resource-limit object across seed states. One test lowered a limit and contaminated a later test. The correct fix copied nested mutable configuration when building each seed. `test/storage.test.js:309` ("generated seed datasets do not share mutable limits or permission arrays") now guards it. Weakening the later assertion would have hidden the defect. This is why repeatable setup matters. When a test passes alone but fails in a suite, investigate shared state, clocks, files, ports, and unfinished asynchronous work before assuming the domain rule is wrong.

Never print workspace tokens or the original data file to debug authentication. Inspect synthetic fixtures, token identifiers, scopes, and response status instead. Record a minimal reproduction a teammate can run safely on their machine.
