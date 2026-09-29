import test from "node:test";
import assert from "node:assert/strict";

import { matchConstraint, evaluateSnapshot } from "../src/core/evaluation.js";
import { buildSeedState } from "../src/server/defaults.js";
import { compileSnapshot } from "../src/core/snapshot.js";

test("gradual rollout is deterministic for the same stickiness value", () => {
  const state = buildSeedState();
  const project = state.projects[0];
  const environment = state.environments.find(
    (item) => item.key === "production",
  );
  const snapshot = compileSnapshot(state, project.id, environment.id);

  const first = evaluateSnapshot(snapshot, {
    userId: "same-user",
    plan: "pro",
  });
  const second = evaluateSnapshot(snapshot, {
    userId: "same-user",
    plan: "pro",
  });

  assert.deepEqual(first, second);
});

test("constraint matching handles string and numeric operators", () => {
  assert.equal(
    matchConstraint(
      {
        field: "plan",
        operator: "in",
        values: ["pro", "enterprise"],
        caseSensitive: false,
      },
      { plan: "Pro" },
    ),
    true,
  );
  assert.equal(
    matchConstraint(
      { field: "age", operator: "greater_than", values: [18] },
      { age: 21 },
    ),
    true,
  );
  assert.equal(
    matchConstraint(
      { field: "email", operator: "ends_with", values: ["@example.com"] },
      { email: "x@sample.com" },
    ),
    false,
  );
});

test("segment reuse affects strategy evaluation", () => {
  const state = buildSeedState();
  const project = state.projects[0];
  const environment = state.environments.find(
    (item) => item.key === "production",
  );
  const rolloutStrategy = state.strategies.find(
    (strategy) => strategy.type === "gradual_rollout",
  );
  rolloutStrategy.parameters.rollout = 100;
  const snapshot = compileSnapshot(state, project.id, environment.id);

  const enabled = evaluateSnapshot(snapshot, {
    userId: "a",
    plan: "enterprise",
  });
  const disabled = evaluateSnapshot(snapshot, { userId: "a", plan: "free" });

  assert.equal(
    enabled.find((flag) => flag.flagKey === "checkout_redesign").enabled,
    true,
  );
  assert.equal(
    disabled.find((flag) => flag.flagKey === "checkout_redesign").enabled,
    false,
  );
});

test("variant assignment is sticky for a user", () => {
  const state = buildSeedState();
  const project = state.projects[0];
  const environment = state.environments.find(
    (item) => item.key === "production",
  );
  const snapshot = compileSnapshot(state, project.id, environment.id);

  const first = evaluateSnapshot(snapshot, {
    userId: "variant-user",
    plan: "pro",
  });
  const second = evaluateSnapshot(snapshot, {
    userId: "variant-user",
    plan: "pro",
  });

  assert.equal(
    first.find((flag) => flag.flagKey === "checkout_redesign").variant?.name,
    second.find((flag) => flag.flagKey === "checkout_redesign").variant?.name,
  );
});
