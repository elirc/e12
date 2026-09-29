import test from "node:test";
import assert from "node:assert/strict";
import {
  matchConstraint,
  matchConstraints,
  evaluateSnapshot,
} from "../src/core/evaluation.js";
import { buildSeedState } from "../src/server/defaults.js";
import { compileSnapshot } from "../src/core/snapshot.js";

function fixture(alter = () => {}) {
  const state = buildSeedState();
  const strategy = state.strategies.find(
    (item) => item.type === "gradual_rollout",
  );
  strategy.parameters.rollout = 100;
  alter(state, strategy);
  return compileSnapshot(state, state.projects[0].id, strategy.environmentId);
}
const checkout = (snapshot, context = { userId: "a", plan: "pro" }) =>
  evaluateSnapshot(snapshot, context).find(
    (item) => item.flagKey === "checkout_redesign",
  );

test("missing context cannot match a negative or inverted constraint", () => {
  assert.equal(
    matchConstraint(
      { field: "plan", operator: "not_in", values: ["free"] },
      {},
    ),
    false,
  );
  assert.equal(
    matchConstraint(
      { field: "plan", operator: "equals", values: ["free"], inversion: true },
      {},
    ),
    false,
  );
  assert.equal(
    matchConstraint(
      { field: "age", operator: "less_than", values: [18], inversion: true },
      { age: null },
    ),
    false,
  );
});

test("inherited context fields do not participate in evaluation", () => {
  const context = Object.create({ plan: "pro", userId: "inherited" });
  assert.equal(
    matchConstraint(
      { field: "plan", operator: "equals", values: ["pro"] },
      context,
    ),
    false,
  );
  assert.equal(checkout(fixture(), context).enabled, false);
});

test("unknown operators and malformed constraints fail closed even with inversion", () => {
  for (const constraint of [
    null,
    { field: "plan", operator: "typo", values: ["pro"], inversion: true },
    { field: "plan", operator: "in", values: "pro" },
    { field: "plan", operator: "equals", values: [], inversion: true },
  ]) {
    assert.equal(matchConstraint(constraint, { plan: "pro" }), false);
    assert.equal(
      matchConstraints([constraint], { plan: "pro" }).matched,
      false,
    );
  }
});

test("numeric comparisons reject coercible strings, null, booleans and infinities", () => {
  for (const age of ["20", "", null, true, Infinity, NaN]) {
    assert.equal(
      matchConstraint(
        {
          field: "age",
          operator: "greater_than",
          values: [18],
          inversion: true,
        },
        { age },
      ),
      false,
    );
  }
  assert.equal(
    matchConstraint(
      { field: "age", operator: "greater_than", values: [18] },
      { age: 20 },
    ),
    true,
  );
});

test("invalid dates and empty string patterns cannot match through inversion", () => {
  assert.equal(
    matchConstraint(
      {
        field: "joined",
        operator: "date_after",
        values: ["2020-01-01"],
        inversion: true,
      },
      { joined: "invalid" },
    ),
    false,
  );
  assert.equal(
    matchConstraint(
      { field: "plan", operator: "starts_with", values: [""], inversion: true },
      { plan: "pro" },
    ),
    false,
  );
});

test("a missing referenced segment disables its strategy instead of dropping the rule", () => {
  const result = checkout(
    fixture((state) => {
      state.segments = [];
    }),
  );
  assert.equal(result.enabled, false);
  assert.match(result.reasons.join(" "), /Missing segment/);
});

test("invalid rollout percentages never enable the strategy", () => {
  for (const rollout of [-1, 101, "100", NaN, 25.5]) {
    assert.equal(
      checkout(
        fixture((_state, strategy) => {
          strategy.parameters.rollout = rollout;
        }),
      ).enabled,
      false,
    );
  }
});

test("invalid variant weights do not produce a misleading assignment", () => {
  for (const weight of [-1, "50", 101, 30]) {
    const result = checkout(
      fixture((state, strategy) => {
        state.variants.find((item) => item.strategyId === strategy.id).weight =
          weight;
      }),
    );
    assert.equal(result.enabled, true);
    assert.equal(result.variant, null);
  }
});

test("variant assignment requires an explicit own identity or session ID", () => {
  const snapshot = fixture((_state, strategy) => {
    strategy.type = "enabled_for_all";
    strategy.segmentIds = [];
  });
  assert.equal(checkout(snapshot, {}).variant, null);
  assert.ok(checkout(snapshot, { sessionId: "session-a" }).variant);
});
