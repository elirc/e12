# Feature Flag Platform

A dependency-light reference implementation of a multi-project feature flag platform.

## What is included

- Control plane APIs for projects, environments, flags, strategies, segments, variants, dependencies, tokens, dashboard, and audit logs
- Evaluation plane APIs backed by cached project/environment snapshots
- JSON persistence so the core data model stays visible and easy to inspect
- Static admin UI for project overview, flag management, tokens, playground, and audit history
- Reference browser and server SDKs
- Automated tests using Node's built-in test runner

## Why this shape

The goal here is clarity over production polish. The codebase keeps the interesting parts visible:

- `src/core`: shared evaluation logic, hashing, constraints, variants, snapshot compilation
- `src/server`: persistence, RBAC/auth, APIs, metrics, audit logging, and static file hosting
- `src/ui`: dependency-free admin UI
- `sdk`: tiny reference SDKs
- `test`: focused tests for rollout and safety rules

## Quick start

```bash
npm test
node src/server/server.js
```

Then open `http://localhost:3000`.

## Seed tokens

These plaintext tokens are only used to bootstrap the local demo instance. They are hashed at rest in `data/state.json`.

- Admin PAT: `demo-instance-admin-token`
- Production client token: `demo-production-client-token`
- Development frontend token: `demo-development-frontend-token`

## Notes

- The platform separates admin writes from evaluation by compiling and caching snapshots per project/environment.
- Multiple strategies on the same flag/environment use OR semantics.
- Segment updates affect every strategy that references them because the evaluator resolves segment constraints from snapshots.
- Dependencies are limited to the same project and cycle-checked before writes are accepted.
- The UI is intentionally simple; it is there to make the domain model easy to explore.
