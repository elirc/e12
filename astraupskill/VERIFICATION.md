# Verification guide and limits

The completed implementation has **118 distinct passing checks**: 98 backend tests and 20 real Chromium workflows. The [machine-readable results](../verification/validated-results.json) record commands, outcomes, workflow names, setup gates, and preservation evidence. Repeated focused/full/clean-copy cases are counted once.

The full backend run passed all 98 cases. It covers typed contracts, current-token authorization, project scoping, reference-safe resource deletion, protected-environment acknowledgment, metrics batches/limits, request snapshots, durable-write ordering and failure injection, SDK/context behavior, and seed isolation. A later fresh source copy ran the documented `npm test` script and passed the same 98 cases after source formatting, with no npm installation or runtime package dependencies.

The final browser run passed all 20 workflows in 92.54 seconds against an isolated synthetic dataset. It exercised the eight resource editors, hostile text rendered literally, pagination/search, stale edits preserving changed fields, refreshing unedited fields, explicit protected acknowledgment, malformed JSON with a retained draft, one-time token display/revocation, an accepted creation whose response was lost, server 500 review, member/viewer controls, context evaluation, and mobile layout. No uncaught browser JavaScript errors were observed. The first run correctly rejected an invalid role in the test fixture; the fixture was corrected rather than weakening application authorization.

Fresh-copy setup issued a new owner token without logging its plaintext, refused a second initialization without changing the file, started the actual CLI server, authenticated the owner, and served all three UI assets byte-for-byte from that copy. The original `data/state.json` was independently hash-checked against its baseline and is excluded from delivery. Frontend JavaScript syntax and the Python browser script's syntax were checked. Ten older onboarding pages retain historical notices and exact original copies.

All five final workflow screenshots were opened and reviewed. The tested desktop and 390-pixel mobile layouts are readable; the mobile workflow also checks page width. Subsequent CSS adds wrapping for long editor headings and gives token metadata the full form width; these limited presentation changes do not alter the checked CRUD behavior. Screenshot coverage is representative, not a claim that every possible input or viewport was inspected.

| Reviewed view | Image |
| --- | --- |
| Desktop list and new-flag form | [Desktop workspace](images/01-desktop.png) |
| Retained draft and latest accepted record | [Conflict review](images/02-conflict-review.png) |
| Typed variant payload editor | [Variant editor](images/03-variant-editor.png) |
| Read-only actor's inspection view | [Viewer workspace](images/04-viewer.png) |
| Stacked layout at 390 pixels | [Mobile workspace](images/05-mobile.png) |

## Browser toolchain, pinned

The Node side is pinned in `package-lock.json`. The browser side used Python 3.13 (3.13.3 on the fix-pass machine) with `requirements-browser.txt`:

```
(see requirements-browser.txt)
```

Install with `python -m pip install -r requirements-browser.txt` then `python -m playwright install chromium`; Playwright downloads the Chromium build matching its own version, so pinning Playwright pins Chromium.

## Reproduce the backend checks

Run `npm test` from this project. The runner invokes Node's built-in test facility on explicit `.test.js` files. Fixtures create new temporary state, close their own loopback servers, and clean only their own directories. They do not require your workspace token, contact a provider, or reseed `data/state.json`. The backend coverage includes authorization, contracts, reference-safe CRUD, protected configuration, metrics validation, context-sensitive evaluation, SDK refresh behavior, storage replacement failures, and HTTP boundaries.

For a focused investigation, run `node --test test/authorization.test.js` or another actual test file. Preserve the failure output before changing the code, then record the passing output after your fix. Do not add the counts from repeated focused and full runs as if they were distinct tests. A helper module being loaded is not a behavioral case.

## Reproduce browser workflows

The optional [browser requirements](../verification/requirements-browser.txt) belong in a separate development environment. [verify_browser.py](../verification/verify_browser.py) starts [browser-fixture.js](../verification/browser-fixture.js) with a newly owned temporary state file, uses an ephemeral loopback port, and writes evidence to a directory you name. That directory must not already exist. The fixture's synthetic credentials are for the isolated test only.

The browser suite exercises explicit sign-in, list pagination/search, literal rendering of user text, CRUD forms, stale-edit review, protected acknowledgment, one-time token display, uncertain creation responses, role-based controls, context evaluation, and a narrow mobile viewport. It records screenshots and uncaught JavaScript errors. Inspect screenshots at desktop and mobile sizes, including long names, comparison panels, and disabled controls. Browser selectors passing does not independently establish accessibility across assistive technologies or compatibility with every browser.

## Inspect preservation and setup separately

Before applying a delivery, compare the original data file's hash with its baseline and exclude data files from the finite change manifest. Preserved originals under `docs/original` allow before/after review. Test owner setup with a new file, verify it refuses a second initialization, and start against that same path. Do not run setup against the user's original workspace as a verification shortcut.

## Known limits to carry into reviews

Persistence uses local JSON, a cooperating-writer lease, revision/digest checks, and same-directory replacement. A killed writer can leave a lease or temporary file; the application does not steal or automatically delete it. This is not a distributed store or universal power-loss guarantee. Persisted validation checks basic collection shape and identity, not a complete relational migration schema. JSON parsing does not reject duplicate property names. Date constraints use finite JavaScript date parsing rather than strict calendar-date validation.

The UI requires review after an uncertain write but does not implement durable idempotency receipts. Metrics are bounded and validated, without automatic retention cleanup or ingestion deduplication. One-time token plaintext cannot be recovered from the stored hash. SDK request bodies are bounded, while parsed response bodies do not have a streaming byte cap. The app has no account recovery flow, production deployment verification, or distributed rate limiter. These are explicit boundaries for future learning, not features implied by a passing local test suite.
