import test from "node:test";
import assert from "node:assert/strict";
import { serviceFixture } from "./fixtures.js";
import { SEED_TOKENS } from "../src/core/constants.js";

const headers = { authorization: `Bearer ${SEED_TOKENS.client}` };

test("metrics store the authenticated token scope and summarize accepted events", (t) => {
  const { service, admin, store, projectId, production } = serviceFixture(t);
  const flagId = store.getState().featureFlags[0].id;
  assert.equal(
    service.ingestMetrics(headers, {
      impressions: [
        {
          flagId,
          enabled: true,
          variantName: "control",
          contextHash: "a".repeat(64),
        },
      ],
    }).accepted,
    1,
  );
  const stored = store.getState().metricsImpressions[0];
  assert.equal(stored.projectId, projectId);
  assert.equal(stored.environmentId, production.id);
  assert.deepEqual(
    service.summarizeMetrics(admin, {
      projectId,
      environmentId: production.id,
    }),
    [{ flagId, impressions: 1, enabledCount: 1 }],
  );
});

test("metrics cannot override the token's project or environment", (t) => {
  const { service, store, development } = serviceFixture(t);
  const flagId = store.getState().featureFlags[0].id;
  for (const extra of [
    { projectId: "prj_other" },
    { environmentId: development.id },
  ]) {
    assert.throws(
      () =>
        service.ingestMetrics(headers, {
          impressions: [{ flagId, enabled: true, ...extra }],
        }),
      /scope differs/,
    );
  }
  assert.equal(store.getState().metricsImpressions.length, 0);
});

test("invalid flags or variants reject the whole batch without partial acceptance", (t) => {
  const { service, store } = serviceFixture(t);
  const flagId = store.getState().featureFlags[0].id;
  const version = store.getState().meta.version;
  for (const invalid of [
    { flagId: "flag_missing", enabled: true },
    { flagId, enabled: true, variantName: "unknown" },
  ]) {
    assert.throws(() =>
      service.ingestMetrics(headers, {
        impressions: [{ flagId, enabled: true }, invalid],
      }),
    );
  }
  assert.equal(store.getState().metricsImpressions.length, 0);
  assert.equal(store.getState().meta.version, version);
});

test("metrics reject coercion, empty batches, excessive batches and arbitrary fields", (t) => {
  const { service, store } = serviceFixture(t);
  const flagId = store.getState().featureFlags[0].id;
  for (const impressions of [
    [],
    [{ flagId, enabled: "true" }],
    [{ flagId, enabled: true, customerEmail: "not-collected@example.invalid" }],
    Array.from({ length: 101 }, () => ({ flagId, enabled: false })),
  ]) {
    assert.throws(() => service.ingestMetrics(headers, { impressions }));
  }
});

test("unscoped personal tokens cannot attribute metrics to a caller-supplied project", (t) => {
  const { service, store, projectId, production } = serviceFixture(t);
  assert.throws(
    () =>
      service.ingestMetrics(
        { authorization: `Bearer ${SEED_TOKENS.admin}` },
        {
          impressions: [
            {
              flagId: store.getState().featureFlags[0].id,
              enabled: true,
              projectId,
              environmentId: production.id,
            },
          ],
        },
      ),
    /must have a known/,
  );
});

test("accepted metrics prevent destructive removal of their flag", (t) => {
  const { service, admin, store } = serviceFixture(t);
  const flagId = store.getState().featureFlags[0].id;
  service.ingestMetrics(headers, { impressions: [{ flagId, enabled: false }] });
  service.updateFlag(admin, flagId, {
    archived: true,
    confirmation: "CONFIRM:production",
  });
  assert.throws(
    () =>
      service.deleteFlag(admin, flagId, { confirmation: "CONFIRM:production" }),
    /retained metrics/,
  );
});

test("evaluation rate limits apply per token across request snapshots", (t) => {
  const { service } = serviceFixture(t, (state) => {
    state.resourceLimits.evaluationRequestsPerMinute = 1;
  });
  assert.ok(
    service.evaluateClient(headers, { context: { userId: "a", plan: "pro" } })
      .flags,
  );
  assert.throws(
    () =>
      service.evaluateClient(headers, {
        context: { userId: "b", plan: "pro" },
      }),
    /rate limit/,
  );
});

test("metrics retention is bounded without silently dropping historical events", (t) => {
  const { service, store } = serviceFixture(t, (state) => {
    state.metricsImpressions = Array.from({ length: 20000 }, (_, index) => ({
      id: `imp_${index}`,
      projectId: state.projects[0].id,
      environmentId: state.environments.find(
        (item) => item.key === "production",
      ).id,
      flagId: state.featureFlags[0].id,
      enabled: false,
    }));
  });
  const flagId = store.getState().featureFlags[0].id;
  const version = store.getState().meta.version;
  assert.throws(
    () =>
      service.ingestMetrics(headers, {
        impressions: [{ flagId, enabled: true }],
      }),
    /retention limit/,
  );
  assert.equal(store.getState().metricsImpressions.length, 20000);
  assert.equal(store.getState().meta.version, version);
});
