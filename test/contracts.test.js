import test from "node:test";
import assert from "node:assert/strict";
import {
  validateOperation,
  validateEvaluationContext,
  validateStrategySettings,
} from "../src/server/contracts.js";

test("unknown and misspelled fields are rejected instead of ignored", () => {
  assert.throws(
    () => validateOperation("updateProject", { descriptino: "Lost field" }),
    /unknown field/,
  );
  assert.throws(
    () => validateOperation("updateFlag", { projectId: "prj_other" }),
    /unknown field/,
  );
  assert.throws(
    () =>
      validateOperation("createFlag", {
        name: "Flag",
        key: "flag",
        type: "release",
        projectId: "prj_a",
        archived: true,
      }),
    /unknown field/,
  );
  assert.throws(
    () => validateOperation("deleteFlag", { force: true }),
    /unknown field/,
  );
});

test("patch omission is preserved while false and empty descriptions remain explicit", () => {
  assert.deepEqual(
    validateOperation("updateFlag", { impressionData: false, description: "" }),
    { impressionData: false, description: "" },
  );
  assert.throws(() => validateOperation("updateFlag", {}), /editable field/);
  assert.throws(
    () => validateOperation("updateFlag", { name: null }),
    /valid text/,
  );
});

test("booleans and percentages never rely on coercion", () => {
  for (const archived of ["false", 0, null])
    assert.throws(() => validateOperation("updateFlag", { archived }));
  for (const rollout of ["25", -1, 101, true, 0.5])
    assert.throws(() =>
      validateOperation("createStrategy", {
        flagId: "flag_a",
        environmentId: "env_a",
        type: "gradual_rollout",
        parameters: { rollout },
      }),
    );
});

test("resource names and keys are normalized and bounded", () => {
  assert.equal(
    validateOperation("updateProject", { name: "  Training  " }).name,
    "Training",
  );
  for (const key of ["MixedCase", "bad key", "x".repeat(81)])
    assert.throws(() => validateOperation("updateFlag", { key }));
  assert.throws(
    () => validateOperation("updateProject", { name: "two\nlines" }),
    /single line/,
  );
});

test("reference arrays reject duplicates and empty project environment selections", () => {
  assert.throws(
    () => validateOperation("updateProject", { environmentIds: [] }),
    /1..8/,
  );
  assert.throws(
    () =>
      validateOperation("updateProject", {
        environmentIds: ["env_a", "env_a"],
      }),
    /duplicate/,
  );
});

test("strategy settings must match a supported strategy type", () => {
  assert.throws(
    () => validateStrategySettings({ type: "custom", parameters: {} }),
    /unsupported/,
  );
  assert.throws(
    () => validateStrategySettings({ type: "gradual_rollout", parameters: {} }),
    /percentage/,
  );
  assert.throws(
    () =>
      validateStrategySettings({
        type: "disabled",
        parameters: { rollout: 100 },
      }),
    /only gradual/,
  );
});

test("constraints validate operators and comparison value types", () => {
  const make = (constraint) =>
    validateOperation("createSegment", {
      name: "Segment",
      constraints: [constraint],
    });
  assert.throws(
    () => make({ field: "age", operator: "greater_than", values: ["18"] }),
    /requires a number/,
  );
  assert.throws(
    () => make({ field: "plan", operator: "typo", values: ["pro"] }),
    /unsupported/,
  );
  assert.throws(
    () => make({ field: "plan", operator: "starts_with", values: [""] }),
    /nonempty/,
  );
  assert.throws(
    () => make({ field: "constructor", operator: "equals", values: [true] }),
    /reserved/,
  );
});

test("variant collections reject invalid totals, duplicate names and payload mismatches", () => {
  const make = (variants) =>
    validateOperation("createStrategy", {
      type: "enabled_for_all",
      flagId: "flag_a",
      environmentId: "env_a",
      variants,
    });
  assert.throws(() => make([{ name: "a", weight: 20 }]), /sum to 100/);
  assert.throws(
    () =>
      make([
        { name: "a", weight: 50 },
        { name: "a", weight: 50 },
      ]),
    /unique/,
  );
  assert.throws(
    () => make([{ name: "a", weight: 100, payload: {} }]),
    /string payloads/,
  );
  assert.equal(
    make([
      {
        name: "a",
        weight: 100,
        payloadType: "json",
        payload: { color: "blue" },
      },
    ]).variants[0].payload.color,
    "blue",
  );
});

test("evaluation context must be bounded plain JSON", () => {
  for (const context of [
    null,
    [],
    "plan",
    { value: Infinity },
    { value: new Date() },
  ])
    assert.throws(() => validateEvaluationContext(context));
  assert.deepEqual(validateEvaluationContext({ plan: "pro", age: 21 }), {
    plan: "pro",
    age: 21,
  });
});
