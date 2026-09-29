# What This File Is For

`src/ui/app.js` is the browser-side admin application. It manages local page state, talks to the admin APIs, and renders the main operator workflows without a frontend framework.

Type of file:

- page-level UI controller
- browser state coordinator

# Why This File Matters

This file is important because it exposes the product from the user’s point of view. It also teaches a junior developer how much coordination work a framework usually hides.

It is worth studying for:

- UI-to-API flow tracing
- manual state management
- re-rendering after mutations
- the risks of implicit UI assumptions

# Key Exports / Main Units

This file does not export modules in the library sense; it runs in the browser. Its main units are:

- `state`
  - Holds token, bootstrap data, selected project/environment, and selected flag.
- `els`
  - Centralized DOM element references.
- `api(path, options = {})`
  - Shared fetch helper with bearer token injection.
- render helpers:
  - `renderSelectors()`
  - `renderFlags()`
  - `renderFlagDetail()`
  - `renderTokens()`
  - `renderAudit()`
  - `refreshDashboard()`
- `loadBootstrap()`
  - Main initial-load and post-mutation refresh flow.

# How It Works

The file follows a straightforward loop:

1. collect DOM references
2. load bootstrap data from `/api/admin/bootstrap`
3. derive selected project/environment/flag
4. render panels from current in-memory state
5. on form submission:
   - collect input
   - call an API
   - reset form where appropriate
   - reload bootstrap data or refresh a panel

This is not a reactive component system. Rendering is manual and coarse-grained.

## Local state model

The `state` object is the only real client-side store. The rest of the UI derives from it.

That means bugs often come from one of two places:

- state was not updated after an interaction
- state was updated, but the corresponding render function was not called

## API usage

The UI mostly relies on:

- `/api/admin/bootstrap` for initial and refreshed admin data
- `/api/admin/dashboard` for dashboard details
- create endpoints for projects, flags, strategies, and tokens
- `/api/admin/playground` for debug evaluation

## Rendering style

Most rendering is done with `innerHTML` string templates. That is simple and fast to read, but it puts correctness pressure on manual escaping, state checks, and render ordering.

# How It Connects To Other Files

Inbound relationships:

- Loaded by `src/ui/index.html`
- Served by `src/server/server.js`

Outbound relationships:

- Talks to routes implemented in `src/server/router.js`
- Depends heavily on response shapes produced by `src/server/services.js`

Important contracts:

- The bootstrap endpoint must return users, projects, environments, flags, segments, tokens, audit logs, and resource limits in the shapes this UI expects.
- The UI assumes form submissions can be followed by a full bootstrap reload to restore truth.

# Important Design Choices

- No frontend framework
  - Great for transparency and learning.
- Single shared bootstrap call
  - Reduces initial network choreography at the cost of a larger payload.
- Re-fetch after mutation instead of maintaining complex optimistic state
  - Simpler and safer for a small admin tool.
- Token persisted in `localStorage`
  - Convenient for local use, but not a production-grade auth UX.

Tradeoff:

- The UI is easy to inspect, but manual DOM rendering and coarse reloads can become fragile as complexity grows.

# Things A Junior Dev Should Notice

- `selectedProject()`, `selectedEnvironment()`, and `selectedFlag()` are small but important derivation helpers.
- `loadBootstrap()` both updates state and triggers multiple render functions. It is effectively a mini page refresh cycle.
- Some forms send raw JSON typed by the user. That means parse failures can happen client-side before the request is sent.
- The UI hardcodes certain assumptions, such as default environments used during project creation.
- The rendered separator text appears as `Â·` in some strings, which suggests an encoding or character-copy issue worth noticing.

# Code Review Lens

Focus on:

- state consistency after user actions
- whether render functions are called after state changes
- whether API response assumptions still hold
- error handling around JSON parsing and fetch failures
- whether selection state becomes stale after filters or reloads

Edge cases to challenge:

- selected flag disappears after a refresh
- invalid JSON typed into constraints or variants
- bootstrap request fails after a successful mutation
- user changes project/environment quickly between async requests

Maintainability concerns:

- many responsibilities in one file
- string-template rendering becoming harder to evolve safely

# Common Change Scenarios

- Add a new admin action
  - Inspect the relevant route/service response shape and decide whether a full bootstrap reload or a smaller refresh is safer.
- Add another filter to the flag list
  - Inspect `filteredFlags()`, selection behavior, and detail rendering.
- Improve form validation
  - Inspect where parsing currently happens and whether the server also enforces the same rule.

# Suggested Exercises

- Trace the "create strategy" button from form inputs to API payload to refreshed UI.
- Find one place where stale selection state could cause confusing UI behavior.
- Propose a small refactor that groups render functions more clearly without changing behavior.
- Write down one server response shape this file relies on heavily.

# Observed Facts vs Inference

Observed from code:

- The UI keeps state in a plain object and renders via DOM updates and `innerHTML`.
- After most mutations, it reloads bootstrap data instead of trying to maintain rich local caches.
- It stores the admin token in `localStorage`.

Inference / likely intent:

- The UI is intentionally simple so the system behavior is easy to trace.
- The coarse reload pattern is a deliberate tradeoff to reduce client-side state bugs in a learning-oriented codebase.
