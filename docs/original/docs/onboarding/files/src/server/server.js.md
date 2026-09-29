# What This File Is For

`src/server/server.js` is the application entry point and server assembler. It is not where business logic lives. Its job is to wire together the HTTP server, the persistent store, the service layer, and the static admin UI.

Type of file:

- entry point
- composition root
- infrastructure wiring

# Why This File Matters

This file teaches an important architecture lesson: small apps are easier to grow when the entry point mostly composes modules instead of containing logic itself.

Studying this file helps a junior dev learn:

- how to recognize a composition root
- how runtime boundaries get connected
- why thin entry points are easier to test and reason about

# Key Exports / Main Units

- `createAppServer()`
  - Builds the `PlatformStore`, initializes it, creates the service layer, and returns an `http.Server`.
- `staticFiles`
  - A small route table for static UI assets.
- top-level `if (process.argv[1] === fileURLToPath(import.meta.url))`
  - Lets the file work both as an importable module and as a direct executable script.

# How It Works

The control flow is simple:

1. Resolve the UI directory and define a small map of static files.
2. `createAppServer()` creates a store and service once for the process.
3. Each incoming request is classified:
   - API request: delegate to `handleApiRequest(...)`
   - static request: serve one of the known UI files
   - unknown request: return `404`
4. If the file is run directly, it listens on `process.env.PORT || 3000`.

One subtle but important detail is this branch:

```js
const handled = await handleApiRequest(request, response, { store, service });
if (handled === false) {
  // send 404
}
```

That explicit `=== false` matters. The route handler may already have written the response. Treating any falsy value as "unhandled" would risk writing headers twice.

# How It Connects To Other Files

Inbound relationships:

- The Node runtime executes this file when starting the app.
- Tests or scripts can import `createAppServer()` without auto-starting the server.

Outbound relationships:

- Calls `handleApiRequest(...)` from `src/server/router.js`
- Instantiates `PlatformStore` from `src/server/store.js`
- Creates the service object via `createPlatformService(...)` from `src/server/services.js`
- Serves files from `src/ui/`

Contract that matters:

- `router.js` must clearly signal whether it handled the request.

# Important Design Choices

- Importable server factory instead of only a side-effect script
  - Makes smoke testing and reuse easier.
- Explicit static file map instead of directory serving
  - Simpler and safer for a tiny app.
- Store and service created once per process
  - Keeps shared state and cache lifetime obvious.

Tradeoff:

- Simplicity is high, but there is no middleware stack or framework-level routing support.

# Things A Junior Dev Should Notice

- This file intentionally does not know business rules.
- Static file serving is whitelist-based, not "serve everything in the folder."
- The store is process-local. If you later add multiple processes, this file’s assumptions stop being enough.

# Code Review Lens

Focus on:

- whether new code belongs here or in a deeper layer
- response lifecycle correctness
- accidental coupling between request handling and business logic
- whether server wiring stays easy to test

Easy-to-miss risks:

- writing to the response after a delegated handler already ended it
- adding per-request store/service construction and breaking shared cache behavior
- broadening static file access unintentionally

# Common Change Scenarios

- Add a new top-level static asset
  - Check `staticFiles` and whether the UI actually references it.
- Add graceful shutdown or startup hooks
  - Inspect how store/service lifecycle should behave.
- Add a new runtime boundary, such as background jobs
  - Keep composition here, but put the real logic elsewhere.

# Suggested Exercises

- Trace one request from this file into `router.js` and then into `services.js`.
- Explain why `createAppServer()` is more test-friendly than auto-listening at import time.
- Identify one thing that would get harder if this file started owning validation logic.

# Observed Facts vs Inference

Observed from code:

- The file builds exactly one `PlatformStore` and one service object per server instance.
- API requests and static file requests are handled in separate branches.
- The file supports both importable and directly executable usage.

Inference / likely intent:

- The author wants a clean separation between wiring and domain logic.
- The explicit handled/unhandled API contract exists partly because a previous double-response bug was considered worth preventing.
