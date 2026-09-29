> Historical documentation: this page describes the original implementation. Setup, storage, SDK evaluation, authorization, and the administration UI have changed. Start with the [current CRUD learning course](../../../../../astraupskill/README.md); use this page for before/after comparison.

# What This File Is For

`src/core/evaluation.js` is the runtime decision engine for feature flags. It answers whether a flag is enabled for a given context and, if so, which variant should be returned.

Type of file:

- core domain logic
- evaluator

# Why This File Matters

This file is the heart of the product. Everything else exists to feed accurate input into it or present its output safely.

It teaches:

- how to encode business rules as deterministic runtime decisions
- how to separate data preparation from evaluation
- how small functions can still be the highest-risk correctness surface in a system

# Key Exports / Main Units

- `matchConstraint(constraint, context = {})`
  - Evaluates one constraint.
- `matchConstraints(constraints = [], context = {})`
  - Evaluates a list of constraints and collects failure reasons.
- `evaluateFlag(flagRecord, snapshot, context, memo = new Map(), stack = [])`
  - Evaluates one flag, including dependencies and strategies.
- `evaluateSnapshot(snapshot, context = {})`
  - Evaluates all flags in a compiled snapshot.

Important internal helpers:

- `resolveStrategyConstraints(...)`
  - Merges segment constraints with strategy-local constraints.
- `matchGradualRollout(...)`
  - Performs deterministic rollout bucketing.
- `pickVariant(...)`
  - Performs deterministic variant assignment.
- `evaluateStrategy(...)`
  - Evaluates one strategy against context.

# How It Works

## Constraint evaluation

`matchConstraint(...)` supports several operators, including string, set, numeric, and date comparisons. Case sensitivity is handled by normalizing string values before comparison.

## Strategy evaluation

For each strategy:

1. merge segment constraints and strategy constraints
2. fail fast if constraints do not match
3. apply type-specific logic:
   - `disabled`
   - `enabled_for_all`
   - `gradual_rollout`
   - unknown custom type

Unknown custom strategies currently evaluate as non-matching and report a reason. That is safer than silently enabling them.

## Flag evaluation

`evaluateFlag(...)` handles higher-level rules:

1. return memoized result if already computed
2. detect dependency cycles during recursive evaluation
3. disable archived flags immediately
4. recursively require all parent dependencies to be enabled
5. use explicit strategies, or fall back to the snapshot’s default strategy
6. evaluate strategies with OR semantics
7. if multiple strategies match, use the first one by pre-sorted order
8. assign a variant from the chosen strategy

## Snapshot evaluation

`evaluateSnapshot(...)` simply evaluates every flag in the snapshot with shared memoization, which matters for dependency reuse.

# How It Connects To Other Files

Inbound relationships:

- Called by `src/server/services.js` for both playground and client evaluation
- Tested by `test/evaluation.test.js`

Outbound relationships:

- Uses `bucketValue(...)` from `src/core/hash.js`
- Consumes the snapshot shape produced by `src/core/snapshot.js`

Important contracts:

- Strategies are expected to already include attached variants.
- `snapshot.defaultStrategy` is expected to exist.
- `sortOrder` has already been handled before evaluation starts.

# Important Design Choices

- Deterministic hashing for rollouts and variants
  - Essential for sticky behavior.
- Dependency-aware recursion with memoization
  - Prevents repeated work and handles graph-shaped relationships.
- Returning reasons for failures and matches
  - Helpful for the playground and trusted debug scenarios.
- First-match strategy selection after collecting all matches
  - Keeps OR semantics while still documenting overlap.

Tradeoff:

- The evaluator is easy to read, but it depends heavily on the snapshot being correctly pre-shaped.

# Things A Junior Dev Should Notice

- "Strategy OR semantics" does not mean "combine all matching strategies." The evaluator still picks one winner for variant selection.
- Missing stickiness fields cause gradual rollout to fail closed.
- Archived flags are disabled before strategy logic is considered.
- Dependency recursion uses both a `memo` map and a `stack` array. They solve different problems:
  - `memo` avoids recomputation
  - `stack` detects cycles in the current recursive path
- Variant bucketing uses total weight as the range, not always 100.

# Code Review Lens

Focus on:

- determinism
- fail-closed behavior
- ordering semantics
- dependency recursion correctness
- whether debug reasons remain truthful

Common edge cases:

- missing context fields
- malformed dates or numbers
- overlapping strategies
- empty or invalid variant weights
- missing dependency parents

Maintainability concerns:

- adding new strategy types without corresponding tests
- changing result shapes in ways that break UI or SDK consumers

# Common Change Scenarios

- Add a custom strategy type
  - Inspect `evaluateStrategy(...)`, `src/core/constants.js`, service validation, UI affordances, and tests.
- Change rollout bucketing logic
  - Inspect tests for determinism, SDK expectations, and any migration implications.
- Add richer debug output
  - Inspect `services.js` to ensure untrusted clients still get restricted data.

# Suggested Exercises

- Trace exactly why a flag with a disabled parent dependency ends up disabled.
- Explain why overlapping strategies can both match but only one controls variant selection.
- Propose one additional test for a missing edge case in date or numeric constraint handling.
- Identify one input that causes `gradual_rollout` to fail safely.

# Observed Facts vs Inference

Observed from code:

- The evaluator supports constraint operators, segments, dependencies, gradual rollout, variants, archived flags, and default strategies.
- Multiple matching strategies lead to a reason message saying the first match won by sort order.
- Unknown custom strategies do not match.

Inference / likely intent:

- The design is aiming for deterministic and explainable rollout behavior over maximum plugin flexibility.
- The evaluator is meant to be reusable by both admin debugging tools and production client evaluation.
