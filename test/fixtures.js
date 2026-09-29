import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PlatformStore } from "../src/server/store.js";
import { buildSeedState } from "../src/server/defaults.js";
import { createPlatformService } from "../src/server/services.js";
import { SEED_TOKENS } from "../src/core/constants.js";

export function serviceFixture(t, alter = () => {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "feature-flags-crud-"),
  );
  t.after(() => {
    assertOwnedDirectory(directory);
    for (const name of fs.readdirSync(directory))
      fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  const state = buildSeedState();
  alter(state);
  const store = new PlatformStore(path.join(directory, "state.json"));
  store.initialize(state);
  const service = createPlatformService(store);
  const actor = (token = SEED_TOKENS.admin, scope = "read") =>
    service.getActorFromHeaders({ authorization: `Bearer ${token}` }, scope);
  const admin = actor();
  const projectId = state.projects[0].id;
  const development = state.environments.find(
    (item) => item.key === "development",
  );
  const production = state.environments.find(
    (item) => item.key === "production",
  );
  const createFlag = (key, extra = {}) =>
    service.createFlag(admin, {
      name: key,
      key,
      type: "release",
      projectId,
      environmentIds: [development.id],
      ...extra,
    });
  return {
    directory,
    store,
    service,
    actor,
    admin,
    projectId,
    development,
    production,
    createFlag,
  };
}

function assertOwnedDirectory(directory) {
  if (
    path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
    !path.basename(directory).startsWith("feature-flags-crud-")
  )
    throw new Error("Unexpected fixture cleanup target");
}
