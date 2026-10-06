# Feature Flag Platform: junior-to-mid-level CRUD workshop

This course uses a real administration application to practice the work that turns a collection of forms into a reliable product. A feature flag is a named decision, such as whether a checkout redesign is enabled. Administrators create its configuration; applications submit a user context and receive a decision. You will work on projects, environments, flags, reusable segments, strategies, variants, dependencies, and access tokens. These related resources make the repository useful preparation for business CRUD applications with ownership, permissions, history, and concurrent editors.

Start with the [application README](../README.md). Choose a new `FEATURE_FLAGS_DATA_FILE`, run owner setup, keep the generated token privately, and start the loopback server. Setup refuses to overwrite an existing workspace. The original dataset remains a separate file. Do not use an actual workspace for destructive exercises or copy its token into a test, screenshot, issue, or source file. Automated fixtures create their own temporary data and synthetic credentials.

## Prerequisites and glossary

**Prerequisites:** JavaScript modules and `async`/`await`, HTTP verbs, headers and status codes, and reading JSON as data at rest. No database experience is needed; the workspace is one JSON document.

| Term | Meaning here | Where in this project |
|---|---|---|
| workspace revision | One counter for the whole workspace, raised once per accepted mutation. | `meta.version`, incremented in `mutate` at `src/server/storage.js:308-313` |
| If-Match (428) | Every admin write must name the workspace version it reviewed. | `writeVersion` at `src/server/http-boundary.js:59-75` |
| conflict (409) | The refusal when the named version is no longer current. | the version-and-digest comparison at `src/server/storage.js:292-301` |
| atomic replacement | Write a temporary file, then rename it over the real one. | `#commit` at `src/server/storage.js:228-260` (`.tmp` name on 239, `renameSync` on 249) |
| scope | What a token is allowed to do: `read`, `write`, `admin` or `evaluate`. | `requireScope` at `src/server/services.js:115-121` |
| project membership | A separate question from scope: which projects this actor belongs to. | `canWriteProject` and `requireProjectWrite` at `src/server/services.js:158-195` |
| token hash | Only a SHA-256 hash of an issued token is stored. | `hashToken` at `src/core/hash.js:7-9` |
| snapshot | The compiled, evaluation-ready view of one project environment. | `compileSnapshot` at `src/core/snapshot.js:7-94` |
| bucketing | Turning a stable identity into a number from 1 to 100 so a rollout percentage is reproducible. | `bucketValue` at `src/core/hash.js:15-19`, used by `matchGradualRollout` at `src/core/evaluation.js:167-191` |
| variant weights | Percentages that must add up to 100 before a multivariate strategy is accepted. | `assertVariantWeights` at `src/server/services.js:312-339` |
| audit entry | The recorded fact of a change, filtered by what the reader may see. | `appendAudit` and `visibleAudit` at `src/server/services.js:213-247` |
| protected environment acknowledgment | The literal string `CONFIRM:<environment key>` required before a change touching a protected environment. | `assertProtectedEnvironmentConfirmation` at `src/server/services.js:271-286` |

Line numbers in this course were checked against the code on 2026-10-06. If you edit the source, regenerate them with `grep -n` rather than trusting the old number.

## Learning route

Read [the codebase map](01-CODEBASE-MAP.md) and follow one flag from the form to the accepted file. Then study [the concepts](02-CONCEPTS.md), especially the difference between authentication, permission scope, and project membership. Follow [the worked changes](03-WORKED-CHANGE.md) through a persistence failure and a context-cache defect. Use [testing and debugging](04-TESTING-AND-DEBUGGING.md) to reproduce failures without relying on visual impressions. Complete [the practice assignments](05-PRACTICE.md) before reading [solutions and review](06-SOLUTIONS-AND-REVIEW.md). Finish with [the trace lab](07-TRACE-LAB.md) and record the commands you ran in your own copy of [the verification checklist](VERIFICATION.md).

Plan several focused sessions rather than one marathon. In the first session, run `npm test` (98 cases on Node 22, no install step) and create a development-only flag. In the second, trace its request, explain every reference, and reproduce an invalid update. In the third, open two tabs and resolve a stale edit. In the fourth, investigate a failed storage replacement in a test. After that, work through the practice exercises in order. Each one gives you a `node --test` file to run, so you get a pass/fail answer without a browser.

## First practical example

Create a flag named `Learning banner` with key `learning_banner`, type `release`, and Development as its target environment. Its name is for humans; its key is the stable identifier SDK consumers request. Select the flag and change its description. Observe the workspace revision increase after each accepted mutation. Mark it archived, then delete it. A referenced or metrics-bearing flag may refuse deletion; that refusal protects information, so read the reason instead of deleting related JSON by hand.

Now repeat with a Production target. The editor asks you to acknowledge the protected environment. Change a field after acknowledging: acknowledgment resets because you are now reviewing a different draft. This is an example of user-interface state expressing a domain rule. The server still enforces the rule if a caller bypasses the interface.

## What counts as progress

You are ready for the next assignment when you can explain why the behavior is correct, identify where the invariant lives, and demonstrate a failure case. “It worked when I clicked Save” is the start of verification. A stronger explanation is: “A stale revision returns a conflict, the draft remains visible, and accepting the latest version refreshes fields I did not edit.”

Keep a short engineering journal: the problem, expected behavior, files inspected, smallest change, test evidence, and remaining limitations. Practice writing a review description a teammate can assess without hearing your whole debugging history. Preserve original snapshots under `docs/original`; they are comparison material, not an alternative application to run. The older onboarding notes describe the earlier implementation and should be read with their historical notice.

This is a local learning platform. It does not provide a distributed database, durable request receipts, account recovery, or production operations. Learning to state those limits precisely is part of becoming a mid-level engineer.
