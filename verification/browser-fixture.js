// Disposable local-only fixture. Never points at an existing workspace.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSeedState } from "../src/server/defaults.js";
import { PlatformStore } from "../src/server/store.js";
import { createAppServer } from "../src/server/server.js";
import { createPlatformService } from "../src/server/services.js";
import { hashToken } from "../src/core/hash.js";
const file = path.resolve(process.env.BROWSER_FIXTURE_STATE_PATH || "");
const directory = path.dirname(file);
if (
  path.dirname(directory) !== path.resolve(os.tmpdir()) ||
  !path.basename(directory).startsWith("feature-flags-browser-") ||
  path.basename(file) !== "state.json" ||
  fs.existsSync(file)
)
  throw new Error("Expected a new, owned browser fixture");
const state = buildSeedState();
const tokens = {
  admin: "synthetic-browser-admin",
  member: "synthetic-browser-member",
  viewer: "synthetic-browser-viewer",
};
state.apiTokens = [{ ...state.apiTokens[0], hash: hashToken(tokens.admin) }];
for (const role of ["member", "viewer"]) {
  const userId = `usr_browser_${role}`;
  state.users.push({
    id: userId,
    name: `Browser ${role}`,
    email: `${role}@example.invalid`,
    active: true,
    roles: [role === "member" ? "project_member" : "viewer"],
  });
  state.projectMembers.push({
    id: `mem_browser_${role}`,
    projectId: state.projects[0].id,
    userId,
    role: role === "member" ? "project_member" : "viewer",
  });
  state.apiTokens.push({
    ...state.apiTokens[0],
    id: `tok_browser_${role}`,
    userId,
    hash: hashToken(tokens[role]),
    scopes: role === "member" ? ["read", "write"] : ["read"],
  });
}
const store = new PlatformStore(file);
store.initialize(state);
const service = createPlatformService(store);
const actor = service.getActorFromHeaders({
  authorization: `Bearer ${tokens.admin}`,
});
const projectId = state.projects[0].id;
const developmentId = state.environments.find(
  (item) => item.key === "development",
).id;
for (let i = 1; i <= 23; i++)
  service.createFlag(actor, {
    name: `Paging flag ${String(i).padStart(2, "0")}`,
    key: `paging_${i}`,
    type: "release",
    projectId,
    environmentIds: [developmentId],
  });
const server = createAppServer({ store });
server.listen(0, "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      url: `http://127.0.0.1:${server.address().port}`,
      tokens,
    }),
  ),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
