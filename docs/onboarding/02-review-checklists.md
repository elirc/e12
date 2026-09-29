> Historical documentation: this page describes the original implementation. Setup, storage, SDK evaluation, authorization, and the administration UI have changed. Start with the [current CRUD learning course](../../astraupskill/README.md); use this page for before/after comparison.

# Review Checklists

These checklists are tailored to this repository, but they are written to stay useful in similar service-oriented application codebases.

Use them as prompts, not as a script. A strong review is about noticing where correctness can drift, especially at boundaries.

## Business Logic / Services

What to look for:

- Are core invariants enforced in one place, or duplicated inconsistently?
- Does the code validate ownership, project scoping, environment scoping, and resource limits before mutating state?
- Are audit entries written for sensitive changes?
- Does the method return a shape that callers can actually rely on?

Common failure modes:

- validating some writes but not all equivalent writes
- checking token scope but forgetting project-level authorization
- mutating related collections without keeping them consistent
- introducing a new mutation path that bypasses audit logging

Good questions to ask:

- If this operation succeeds, what must now be true about the stored state?
- If the actor has the right scope but the wrong project, does this still fail?
- What happens when optional fields are omitted?
- Are there hidden invariants between arrays that should be validated together?

Subtle bugs a junior dev might miss:

- allowing a flag to target an environment not enabled for the project
- updating a strategy without rechecking protected production confirmation
- changing variant weights in one place while leaving total weight invalid

## API Routes / Controllers

What to look for:

- Is the route thin and mostly delegating to a service?
- Are request params, query params, and body values parsed consistently?
- Does the route return the right status code for success and failure?
- Are error responses predictable enough for clients to use?

Common failure modes:

- business logic leaking into route handlers
- route-specific parsing bugs that change behavior subtly
- mismatched route parameters and service method arguments
- writing a response twice after one code path already ended it

Good questions to ask:

- Where does transport handling end and business logic begin?
- Is this route accidentally more permissive than the others?
- What does this route return when the body is empty, malformed, or missing fields?

Subtle bugs a junior dev might miss:

- treating `undefined` and `false` as the same thing when parsing booleans
- forgetting that a handler may already have sent the response
- returning debug information to untrusted clients

## Database Schema And Persistence Logic

In this repo the "database" is a JSON file, but the review instincts are the same as with a real persistence layer.

What to look for:

- Does a mutation preserve relationships between entities?
- Are IDs, timestamps, and version increments handled consistently?
- Is cache invalidation coupled correctly to persistence changes?
- Are partial updates safe if a field is omitted?

Common failure modes:

- updating one collection but forgetting a join-like collection
- changing state without bumping version or clearing caches
- storing secrets or plaintext tokens accidentally
- mutating shared objects instead of cloning safely

Good questions to ask:

- If the process crashed halfway through this write, what would be inconsistent?
- Does this write path preserve all required relationships?
- What becomes stale after this write?

Subtle bugs a junior dev might miss:

- persisting a token’s plaintext instead of only its hash
- changing snapshot inputs without invalidating compiled snapshots
- making a mutation directly on `store.state` outside `store.mutate(...)`

## Frontend State And UI Behavior

What to look for:

- Is UI state derived consistently from server responses?
- After a mutation, is the UI reloaded or updated in a way that preserves truth?
- Are selection state changes coordinated with dependent UI panels?
- Are user inputs parsed safely before being sent?

Common failure modes:

- stale selected IDs after the active project/environment changes
- rendering data that no longer exists after a refresh
- silent JSON parsing failures from free-form textareas
- local assumptions that do not match server rules

Good questions to ask:

- What happens if the currently selected flag disappears after refresh?
- What is the source of truth after a write: local state or a re-fetch?
- How does the UI behave if the server rejects the mutation?

Subtle bugs a junior dev might miss:

- a filter leaving the selected flag pointing at a now-hidden item
- resetting a form but not resetting dependent state
- assuming a production confirmation string is always present

## Async Code / Concurrency / Race Conditions

This repo is mostly simple async code, but the risks are still real.

What to look for:

- Does the code assume a request order that may not hold?
- Are reads and writes working against a stable view of data?
- Could two async UI actions overwrite each other’s expectations?
- Is cache state updated atomically with persisted state?

Common failure modes:

- loading data, then mutating based on stale assumptions
- one request refreshing UI while another request changes selection state
- using cached snapshots after writes without invalidation
- time-based rate limits behaving unexpectedly under repeated calls

Good questions to ask:

- What if two writes happen back-to-back?
- What if a refresh completes after the user has already switched projects?
- Is memoization hiding stale state?

Subtle bugs a junior dev might miss:

- using an old selected project/environment after `loadBootstrap()`
- ETag behavior masking a changed underlying assumption
- mutation methods deriving values from old state captured before `store.mutate(...)`

## Auth / Permissions / Security-Sensitive Paths

What to look for:

- Are both authentication and authorization enforced?
- Are token scopes and human roles treated as different checks?
- Are environment/project limits respected for machine tokens?
- Is debug information restricted appropriately?

Common failure modes:

- validating scope but not role
- allowing admin routes for machine tokens
- forgetting that frontend tokens should reveal less than trusted clients
- exposing hashed or plaintext secret material in list responses

Good questions to ask:

- Can this route be called by a token type that should not use it?
- What prevents cross-project or cross-environment access here?
- What sensitive data is included in success or error responses?

Subtle bugs a junior dev might miss:

- a frontend token getting debug reasons that reveal strategy internals
- returning `hash` fields in token list endpoints
- creating a token without scoping it to the intended project/environment

## Realtime Or Event-Driven Code

This repo does not currently have sockets, streams, or background workers. The closest equivalent is snapshot invalidation and client-side polling/refresh behavior.

What to look for:

- Does the code clearly separate configuration writes from read-time cached state?
- Are clients able to detect changed config safely, for example through ETags?

Common failure modes:

- stale snapshots living past a write
- clients not refreshing after config changes

Good questions to ask:

- What is the propagation story after a config update?
- How long could a client keep seeing stale config?

Subtle bugs a junior dev might miss:

- changing snapshot contents without changing version/etag inputs

## Error Handling And Observability

What to look for:

- Do errors include enough information for operators and callers?
- Are status codes meaningful?
- Do sensitive paths fail closed?
- Is there enough audit visibility for state-changing actions?

Common failure modes:

- swallowing useful validation details
- returning 500 for user-caused validation errors
- missing audit entries for important state changes
- UI showing only a vague failure without preserving context

Good questions to ask:

- If this breaks in production, what evidence would we have?
- Does the caller get a useful error without leaking sensitive internals?
- Should this change be auditable?

Subtle bugs a junior dev might miss:

- catching an error and converting it into a generic success-looking response
- forgetting that audit logs are also an observability tool, not only a compliance feature

## Types, Contracts, And Validation

This codebase is plain JavaScript, so review has to compensate for the lack of compiler-enforced contracts.

What to look for:

- Are expected input shapes obvious and consistently enforced?
- Are returned objects stable enough for callers to depend on?
- Do related fields make sense together?

Common failure modes:

- assuming a field exists because the happy-path UI sends it
- returning different shapes for similar endpoints
- trusting free-form JSON from the UI without enough checks

Good questions to ask:

- What are the required vs optional fields here?
- If someone called this API directly, what invalid combinations would get through?
- Would a small schema helper make this path safer?

Subtle bugs a junior dev might miss:

- treating `[]`, `null`, and `undefined` as equivalent when they mean different things
- allowing malformed constraints or variants because only total weight was checked

## Tests And Missing Test Coverage

What to look for:

- Do tests cover the highest-risk invariants, not just happy paths?
- When a PR changes behavior, does the test suite change in a way that proves intent?
- Are tests targeted enough to explain the contract clearly?

Common failure modes:

- adding a new rule without a test
- testing only API success while missing edge cases in core logic
- relying on seed/demo state too heavily instead of arranging explicit cases

Good questions to ask:

- What is the easiest bug this change could introduce?
- Is there a deterministic test for that bug?
- Are we testing the core rule at the narrowest layer possible?

Subtle bugs a junior dev might miss:

- changing evaluation order without a test covering overlapping strategy matches
- adding a new mutation path without a cache invalidation assertion
- changing permission rules without both allowed and denied test cases

## Codebase-Specific High-Risk Areas

If you only have a few minutes, spend them here first:

- `src/server/services.js` for rule consistency, authorization, and audit coverage
- `src/core/evaluation.js` for correctness and determinism
- `src/core/snapshot.js` for stale data, shape drift, and project/environment scoping
- `src/ui/app.js` for state consistency after refresh and mutation flows
