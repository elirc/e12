> Historical documentation: this page describes the original implementation. Setup, storage, SDK evaluation, authorization, and the administration UI have changed. Start with the [current CRUD learning course](../../../../../astraupskill/README.md); use this page for before/after comparison.

# What This File Is For

`src/core/snapshot.js` compiles persisted control-plane state into a read-optimized runtime snapshot for one project/environment pair.

Type of file:

- domain adapter
- read-model compiler

# Why This File Matters

This file embodies one of the best architectural ideas in the repo: write-oriented admin state is transformed into evaluation-oriented runtime state before reads happen.

It teaches:

- why a compiled read model can simplify fast runtime decisions
- how to narrow a large state object into only the data a specific evaluator needs
- why "control plane" and "evaluation plane" are different concerns even in one process

# Key Exports / Main Units

- `compileSnapshot(state, projectId, environmentId)`
  - Main function that compiles a project/environment-specific snapshot.

Important local helper:

- `mapById(items)`
  - Builds quick lookup maps for repeated evaluator access.

# How It Works

The function narrows a broad persisted state object into a much smaller structure:

1. find the requested project, environment, and project/environment mapping
2. return `null` if that combination does not exist
3. gather segments visible to the project
4. gather and sort strategies for the target environment
5. attach variants to each strategy
6. gather dependencies for flags in the project
7. gather flags in the project that are enabled in the requested environment
8. build a default strategy object from the project/environment mapping
9. build lookup maps such as `segmentsById` and `flagsById`

Two details matter a lot:

- strategy sorting by `sortOrder`
  - This supports deterministic "first matching strategy wins" behavior later.
- default strategy compilation
  - This lets evaluation code treat "no explicit strategies" as a normal runtime case rather than a special database read path.

# How It Connects To Other Files

Inbound relationships:

- Called by `PlatformStore.getSnapshot(...)` in `src/server/store.js`

Outbound relationships:

- Uses `createId(...)` from `src/core/hash.js`
- Produces the shape consumed by `src/core/evaluation.js`

Important contracts:

- The snapshot must include enough information for evaluation without forcing evaluation code to read raw store state.
- `evaluation.js` expects fields like `defaultStrategy`, `segmentsById`, `flags`, and `flagsById`.

# Important Design Choices

- Snapshot compiled per project/environment
  - Cuts down evaluation scope and makes token scoping natural.
- Read model includes both list and map forms
  - Slight duplication, but improves evaluator simplicity.
- Variants attached during snapshot compilation
  - Keeps the evaluator focused on decision logic, not data joining.

Tradeoff:

- Snapshot compilation duplicates some information, but buys faster and cleaner evaluation.

# Things A Junior Dev Should Notice

- This file is doing data shaping, not decision-making.
- It filters segments by global-or-project visibility.
- It filters strategies only by environment, then groups them by flag.
- It filters flags by both project membership and feature-flag-environment linkage.
- The generated snapshot ID and ETag depend on `state.meta.version`, which links persistence writes to cacheability.

# Code Review Lens

Focus on:

- whether scoping by project/environment is still correct
- whether every data dependency needed by evaluation is present
- whether ordering assumptions remain deterministic
- whether new fields should live in raw state, snapshot, or evaluator result

Subtle risks:

- accidentally including data from the wrong project
- forgetting to attach variants when changing strategy shape
- adding evaluation-needed fields to persisted state but not to snapshot compilation

# Common Change Scenarios

- Add a new strategy property used by evaluation
  - Inspect both snapshot compilation and `evaluation.js`.
- Change dependency behavior
  - Inspect how dependencies are grouped and how missing parents are handled during evaluation.
- Add segment scoping rules
  - Inspect segment filtering and the evaluator’s segment lookup assumptions.

# Suggested Exercises

- Trace how a flag with no explicit strategies still becomes evaluatable.
- Explain why `flagsById` exists even though `flags` already exists.
- Identify one piece of data that the evaluator does not need and notice that snapshot compilation avoids including more than necessary.

# Observed Facts vs Inference

Observed from code:

- The snapshot is scoped to a single project and environment.
- Strategies are sorted by `sortOrder` and enriched with variants.
- The snapshot includes both `segmentsById` and `flagsById`.

Inference / likely intent:

- The author wants the evaluation layer to operate on a compact, pre-joined structure instead of repeatedly searching raw state.
- The snapshot layer is the main architectural seam that would make a separate evaluation service possible later.
