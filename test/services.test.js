import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { SEED_TOKENS } from "../src/core/constants.js";
import { createPlatformService } from "../src/server/services.js";
import { PlatformStore } from "../src/server/store.js";
import { buildSeedState } from "../src/server/defaults.js";
import { cleanup } from "./helpers.js";

function createMemoryStore() {
  const filePath = path.join(
    os.tmpdir(),
    `feature-flag-test-${Date.now()}-${Math.random()}.json`,
  );
  cleanup(filePath);
  const store = new PlatformStore(filePath);
  store.initialize(buildSeedState());
  return { store, filePath };
}

function headers(token) {
  return { authorization: `Bearer ${token}` };
}

test("dependency validation rejects cross-project cycles", () => {
  const { store, filePath } = createMemoryStore();
  try {
    const service = createPlatformService(store);
    const actor = service.getActorFromHeaders(
      headers(SEED_TOKENS.admin),
      "write",
    );
    const state = store.getState();
    const projectId = state.projects[0].id;

    const first = service.createFlag(actor, {
      projectId,
      name: "Parent",
      confirmation: "CONFIRM:production",
      key: "parent_flag",
      type: "release",
    });
    const second = service.createFlag(actor, {
      projectId,
      name: "Child",
      confirmation: "CONFIRM:production",
      key: "child_flag",
      type: "release",
    });

    service.createDependency(actor, {
      parentFlagId: first.id,
      childFlagId: second.id,
      confirmation: "CONFIRM:production",
    });
    assert.throws(
      () =>
        service.createDependency(actor, {
          parentFlagId: second.id,
          childFlagId: first.id,
          confirmation: "CONFIRM:production",
        }),
      /cycle/i,
    );
  } finally {
    cleanup(filePath);
  }
});

test("token scope enforcement blocks admin access for evaluate-only tokens", () => {
  const { store, filePath } = createMemoryStore();
  try {
    const service = createPlatformService(store);
    assert.throws(
      () => service.getActorFromHeaders(headers(SEED_TOKENS.client), "write"),
      /missing "write" scope/i,
    );
  } finally {
    cleanup(filePath);
  }
});

test("snapshot cache invalidates after mutations", () => {
  const { store, filePath } = createMemoryStore();
  try {
    const service = createPlatformService(store);
    const actor = service.getActorFromHeaders(
      headers(SEED_TOKENS.admin),
      "write",
    );
    const state = store.getState();
    const projectId = state.projects[0].id;
    const environmentId = state.projectEnvironments.find(
      (item) => item.projectId === projectId,
    ).environmentId;

    const firstSnapshot = store.getSnapshot(projectId, environmentId);
    service.createFlag(actor, {
      projectId,
      name: "Cache Test",
      confirmation: "CONFIRM:production",
      key: "cache_test_flag",
      type: "release",
    });
    const secondSnapshot = store.getSnapshot(projectId, environmentId);

    assert.notEqual(firstSnapshot.etag, secondSnapshot.etag);
  } finally {
    cleanup(filePath);
  }
});
