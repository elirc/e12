# Testing and debugging with observable consequences

Run `npm test` from the project root. [verification/run-tests.js](../verification/run-tests.js) discovers only `test/*.test.js`, so helper modules and preserved original source files are not counted as behavioral tests. A passing command is evidence for the cases it ran; it does not prove the interface was exercised or the application is production-ready. Keep the command, exit code, test names, and relevant environment with your work.

## Choose the smallest useful reproduction

If an invalid weight is accepted, start in [contracts.test.js](../test/contracts.test.js) and [crud.test.js](../test/crud.test.js). If the wrong project is visible, use [authorization.test.js](../test/authorization.test.js). If a stale save overwrites accepted data, inspect [http.test.js](../test/http.test.js). For persistence errors, [storage.test.js](../test/storage.test.js) gives a controlled filesystem fixture. Use the real implementation through a small fixture rather than mocking away the behavior you need to verify.

A useful assertion checks accepted state as well as the response. For example: submit a batch containing one valid metric and one invalid metric, assert rejection, then read the accepted store and assert that neither event was appended. Merely expecting an error would miss a partial-write defect. Likewise, a rejected flag edit should preserve its name, its revision, and its audit count.

## Debug a stale edit

Open two tabs using a disposable workspace. Both load the same flag. In tab A, edit its name without saving. In tab B, edit its description and save. Return to A and save: expect a conflict. Inspect the request's `If-Match`, the response status, and the editor's retained name. Choose review latest; compare the latest accepted description and your changed name. Continue with the reviewed version. The resulting flag should contain both changes.

If the description returns to its old value, inspect `changes()` and `renderEditor(latest, draft)` in [app.js](../src/ui/app.js). Is the draft a complete old record or just changed fields? Did a form rebuild reset the baseline incorrectly? Write down which representation exists at each step before changing code. Randomly adding refreshes can hide a race while introducing lost drafts.

## Debug an uncertain creation

The browser verification script intercepts a creation response after the real local server accepts it, then aborts delivery to the page. This models “the request may have succeeded.” The expected behavior is one accepted record, one attempted POST, a retained draft, and blocked writes until review. Do not solve this by automatically submitting again. A durable idempotency design is a separate practice assignment with a larger storage contract.

## Recovering from a stuck lease

Writes take a lease by creating the lock file exclusively (`#withLease` in `src/server/storage.js`: `openSync(lockPath, "wx")`), so a crash between acquire and release leaves the file behind and every later write answers 503 `Another writer owns the state lease; retry later`.

1. **Identify the file.** It is `lockPath` next to the state file (the storage constructor derives it; print `storage.lockPath` from a REPL or read the constructor). Its contents are JSON with the owning process id and a timestamp, written right after acquisition.
2. **Confirm nobody owns it.** Read the JSON; check the pid is not running (`Get-Process -Id <pid>` on Windows, `ps -p <pid>` elsewhere) and that the timestamp is older than any request that could still be in flight. If the pid is alive, do nothing: the lease is real.
3. **Remove it safely.** Stop the server, delete the lock file, start the server, and make one read request before any write. Never delete it while the server runs: a writer may be between acquire and release.
4. **Prove it.** The next write returns 200 and a new lease file appears and disappears around it.

The limit VERIFICATION states ("a stuck lease needs manual recovery") is this procedure.

## Browser checks are optional development dependencies

Use a separate Python environment for [requirements-browser.txt](../verification/requirements-browser.txt), install its pinned package, and provide Chromium through `ASTRA_BROWSER_EXECUTABLE` or Playwright's browser installation. Run:

```powershell
python verification/verify_browser.py verification/browser-evidence-01
```

The evidence directory must be new. [browser-fixture.js](../verification/browser-fixture.js) creates synthetic users and records in a newly owned temporary directory, starts an ephemeral loopback port, and never opens the original dataset. The Python harness records passing workflow names, screenshots, failures, and elapsed time. Inspect the screenshots; successful selectors alone do not prove a usable layout.

## Read failures carefully

An earlier fixture accidentally shared a mutable resource-limit object across seed states. One test lowered a limit and contaminated a later test. The correct fix copied nested mutable configuration when building each seed; weakening the later assertion would have hidden the defect. This is why repeatable setup matters. When a test passes alone but fails in a suite, investigate shared state, clocks, files, ports, and unfinished asynchronous work before assuming the domain rule is wrong.

Never print workspace tokens or the original data file to debug authentication. Inspect synthetic fixtures, token identifiers, scopes, and response status instead. Record a minimal reproduction a teammate can run safely on their machine.
