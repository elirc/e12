> Historical documentation: this page describes the original implementation. Setup, storage, SDK evaluation, authorization, and the administration UI have changed. Start with the [current CRUD learning course](../../../../../astraupskill/README.md); use this page for before/after comparison.

# What This File Is For

`src/server/router.js` is the HTTP routing boundary. It decides which API handler should run for each request, parses request input into usable values, and normalizes JSON responses.

Type of file:

- route/controller layer
- transport adapter

# Why This File Matters

This file is the clearest map of the API surface. It also teaches a valuable design habit: routes should mostly translate and delegate, not own business rules.

It is important to study because it shows:

- how the system is partitioned into admin, client, and metrics APIs
- how HTTP concerns differ from domain concerns
- where malformed or missing input can first enter the program

# Key Exports / Main Units

- `handleApiRequest(request, response, { store, service })`
  - The main dispatcher for API routes.
- `sendJson(response, statusCode, payload, headers = {})`
  - Shared JSON response writer.
- `parseBoolean(value)`
  - Small helper to preserve the difference between "absent" and explicit boolean filters.
- `readJsonBody(request)`
  - Reads and parses request body JSON.
- `matchPath(pathname, pattern)`
  - Lightweight route parameter matcher.

# How It Works

The file does three jobs:

## 1. Parse transport-level input

- query params become filter values
- request bodies are turned into JavaScript objects
- route params are extracted from URL patterns like `:flagId`

## 2. Dispatch by method + pathname

Routes are grouped conceptually:

- `/api/admin/*`
  - control-plane operations
- `/api/client/*`
  - feature evaluation
- `/api/metrics/*`
  - impression ingestion and summary

## 3. Normalize output

- success responses go through `sendJson(...)`
- ETag-based evaluation routes can short-circuit with `304`
- thrown service errors are caught and turned into JSON error payloads

The file is intentionally repetitive in structure. That is not a flaw here. The repetition makes the public surface easy to scan and reduces routing magic.

# How It Connects To Other Files

Inbound relationships:

- Called from `src/server/server.js` for any `/api/*` request.

Outbound relationships:

- Delegates almost all domain work to methods on the object built by `src/server/services.js`
- Calls `store.getState()` only in the bootstrap route to expose resource limits

Important contracts:

- Service methods throw structured errors with `status` and `details`
- Client evaluation may return `notModified` plus an ETag

# Important Design Choices

- Hand-written routing instead of a framework router
  - Good for learning; less good for large route sets.
- Centralized try/catch at the router level
  - Keeps service methods free to signal failure by throwing.
- Thin route handlers
  - Encourages business rules to stay in one place.

Tradeoff:

- Explicitness is high, but adding many more routes would become repetitive.

# Things A Junior Dev Should Notice

- `parseBoolean("")` returns `undefined`, not `false`. That preserves "filter not provided."
- `readJsonBody(...)` assumes JSON if a body exists. There is no schema validation here.
- The router uses both scope-gated admin endpoints and scope-gated evaluation endpoints, but the deeper role checks live in services.
- The bootstrap route is a convenience endpoint that loads many resources at once for the UI.

# Code Review Lens

Focus on:

- whether route code is staying transport-focused
- status code correctness
- path parameter matching correctness
- whether input parsing subtly changes meaning
- whether sensitive routes require the correct scope before delegation

Easy-to-miss risks:

- body parsing errors surfacing as generic 500s if not handled carefully
- exposing too much debug data on client routes
- adding duplicate or overlapping route patterns that shadow each other

# Common Change Scenarios

- Add a new admin endpoint
  - Check whether the route needs `read`, `write`, or `admin` scope and which service layer rule should enforce the deeper permission.
- Add request validation
  - Decide whether it belongs here as transport validation or in `services.js` as business validation.
- Change an evaluation response shape
  - Inspect both SDK files and `src/ui/app.js` before editing.

# Suggested Exercises

- Find three routes that call the same service file but require different scopes.
- Trace how a `POST /api/client/evaluate` request can end in either `304` or `200`.
- Identify one input that the router parses but does not validate deeply.

# Observed Facts vs Inference

Observed from code:

- All API routing is done with direct `if` branches and a simple path matcher.
- Errors thrown during route handling are converted into JSON responses.
- The router delegates almost all real work to the service object.

Inference / likely intent:

- The author prioritized readability and low indirection over framework features.
- The route layer is intentionally small so permission and business rules stay centralized elsewhere.
