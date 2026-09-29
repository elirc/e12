import test from "node:test";
import assert from "node:assert/strict";
import { buildSeedState } from "../src/server/defaults.js";
import { compileSnapshot } from "../src/core/snapshot.js";
import { createPlatformService } from "../src/server/services.js";
import { SEED_TOKENS } from "../src/core/constants.js";

function fixture() {
  const state = buildSeedState();
  state.strategies.find(
    (item) => item.type === "gradual_rollout",
  ).parameters.rollout = 100;
  const store = {
    runOperation: (operation) => operation(),
    useRateLimit: () => true,
    getState: () => state,
    getSnapshot: (project, environment) =>
      compileSnapshot(state, project, environment),
  };
  return createPlatformService(store);
}

test("an unchanged configuration still evaluates each new user context", () => {
  const service = fixture();
  const headers = { authorization: `Bearer ${SEED_TOKENS.client}` };
  const first = service.evaluateClient(headers, {
    context: { userId: "a", plan: "pro" },
  });
  assert.equal(
    first.flags.find((flag) => flag.key === "checkout_redesign").enabled,
    true,
  );
  const second = service.evaluateClient(
    { ...headers, "if-none-match": first.etag },
    { context: { userId: "b", plan: "free" } },
  );
  assert.equal(second.notModified, false);
  assert.equal(
    second.flags.find((flag) => flag.key === "checkout_redesign").enabled,
    false,
  );
});

test("request debug mode is evaluated even when configuration has not changed", () => {
  const service = fixture();
  const headers = { authorization: `Bearer ${SEED_TOKENS.client}` };
  const body = { context: { userId: "a", plan: "pro" } };
  const first = service.evaluateClient(headers, body);
  assert.equal(first.flags[0].reasons, undefined);
  const second = service.evaluateClient(
    { ...headers, "if-none-match": first.etag },
    { ...body, debug: true },
  );
  assert.equal(second.notModified, false);
  assert.ok(Array.isArray(second.flags[0].reasons));
});
