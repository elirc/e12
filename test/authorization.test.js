import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PlatformStore } from "../src/server/store.js";
import { buildSeedState } from "../src/server/defaults.js";
import { createPlatformService } from "../src/server/services.js";
import { hashToken } from "../src/core/hash.js";
import { SEED_TOKENS } from "../src/core/constants.js";

const memberToken = "synthetic-member-token";
function fixture(t, alter = () => {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "feature-flags-auth-"),
  );
  t.after(() => {
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    assert.ok(path.basename(directory).startsWith("feature-flags-auth-"));
    for (const name of fs.readdirSync(directory))
      fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  const state = buildSeedState();
  const projectId = state.projects[0].id;
  const environmentId = state.projectEnvironments[0].environmentId;
  state.users.push({
    id: "usr_member",
    name: "Member",
    email: "member@example.invalid",
    roles: ["project_member"],
  });
  state.projectMembers.push({
    id: "mem_member",
    userId: "usr_member",
    projectId,
    role: "project_member",
  });
  // Deliberately malformed legacy delegation: scope alone must not grant instance administration.
  state.apiTokens.push({
    ...state.apiTokens[0],
    id: "tok_member",
    userId: "usr_member",
    hash: hashToken(memberToken),
  });
  state.projects.push({
    ...state.projects[0],
    id: "prj_private",
    key: "private",
    name: "Private",
  });
  state.featureFlags.push({
    ...state.featureFlags[0],
    id: "flag_private",
    projectId: "prj_private",
    key: "private_flag",
  });
  state.projectEnvironments.push({
    ...state.projectEnvironments[0],
    id: "pe_private",
    projectId: "prj_private",
  });
  state.auditLogs.push(
    {
      id: "audit_visible",
      resourceType: "project",
      resourceId: projectId,
      action: "project.updated",
      after: { id: projectId },
    },
    {
      id: "audit_private",
      resourceType: "project",
      resourceId: "prj_private",
      action: "project.updated",
      after: { id: "prj_private" },
    },
    {
      id: "audit_global",
      resourceType: "token",
      resourceId: state.apiTokens[0].id,
      action: "token.created",
      after: {},
    },
  );
  alter(state);
  const store = new PlatformStore(path.join(directory, "state.json"));
  store.initialize(state);
  const service = createPlatformService(store);
  const actor = (token = SEED_TOKENS.admin, scope = "read") =>
    service.getActorFromHeaders({ authorization: `Bearer ${token}` }, scope);
  return { store, service, actor, projectId, environmentId };
}

test("unfiltered flag listing cannot reveal another project's flags", (t) => {
  const { service, actor, projectId } = fixture(t);
  const member = actor(memberToken);
  assert.ok(
    service.listFlags(member, {}).every((flag) => flag.projectId === projectId),
  );
  assert.throws(
    () => service.listFlags(member, { projectId: "prj_private" }),
    /access denied/,
  );
});

test("project audit and dashboard exclude unrelated or global events", (t) => {
  const { service, actor, projectId, environmentId } = fixture(t);
  const member = actor(memberToken);
  assert.deepEqual(
    service.listAudit(member).map((item) => item.id),
    ["audit_visible"],
  );
  assert.deepEqual(
    service
      .getDashboard(member, projectId, environmentId)
      .recentChanges.map((item) => item.id),
    ["audit_visible"],
  );
  assert.deepEqual(
    service
      .getDashboard(actor(), projectId, environmentId)
      .recentChanges.map((item) => item.id),
    ["audit_visible"],
  );
});

test("member token metadata is limited to their own tokens", (t) => {
  const { service, actor } = fixture(t);
  const tokens = service.listTokens(actor(memberToken));
  assert.deepEqual(
    tokens.map((token) => token.id),
    ["tok_member"],
  );
  assert.ok(tokens.every((token) => token.hash === undefined));
});

test("project lists expose only the current actor's membership for editor permissions", (t) => {
  const { service, actor, projectId } = fixture(t);
  const projects = service.listProjects(actor(memberToken));
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, projectId);
  assert.equal(projects[0].membershipRole, "project_member");
  assert.equal(
    service
      .listProjects(actor())
      .find((project) => project.id === "prj_private").membershipRole,
    null,
  );
});

test("an admin scope on a member token cannot create global resources or mint tokens", (t) => {
  const { service, actor, projectId, environmentId } = fixture(t);
  const member = actor(memberToken, "admin");
  assert.throws(
    () =>
      service.createProject(member, {
        name: "Forbidden",
        key: "forbidden",
        environmentIds: [environmentId],
      }),
    /Instance administrator/,
  );
  assert.throws(
    () =>
      service.createEnvironment(member, {
        name: "Forbidden",
        key: "forbidden",
        type: "test",
      }),
    /Instance administrator/,
  );
  assert.throws(
    () =>
      service.createToken(member, {
        name: "Forbidden",
        type: "client",
        scopes: ["evaluate"],
        projectIds: [projectId],
        environmentIds: [environmentId],
      }),
    /Instance administrator/,
  );
  assert.throws(
    () => service.createSegment(member, { name: "Global segment" }),
    /Instance administrator/,
  );
  assert.throws(
    () => service.revokeToken(member, "tok_member"),
    /Instance administrator/,
  );
});

test("expired, malformed-expiry and inactive-user tokens cannot authenticate", (t) => {
  const { service, store } = fixture(t);
  for (const expiresAt of ["2000-01-01T00:00:00Z", "not-a-date"]) {
    store.mutate((draft) => {
      draft.apiTokens.find((token) => token.id === "tok_member").expiresAt =
        expiresAt;
    });
    assert.throws(
      () =>
        service.getActorFromHeaders({ authorization: `Bearer ${memberToken}` }),
      /expired/,
    );
  }
  store.mutate((draft) => {
    draft.apiTokens.find((token) => token.id === "tok_member").expiresAt = null;
    draft.users.find((user) => user.id === "usr_member").active = false;
  });
  assert.throws(
    () =>
      service.getActorFromHeaders({ authorization: `Bearer ${memberToken}` }),
    /Inactive/,
  );
});

test("personal token scopes cannot exceed the target user's role", (t) => {
  const { service, actor } = fixture(t);
  assert.throws(
    () =>
      service.createToken(actor(SEED_TOKENS.admin, "admin"), {
        name: "Escalation",
        type: "personal",
        userId: "usr_member",
        scopes: ["admin"],
        projectIds: [],
        environmentIds: [],
      }),
    /exceed/,
  );
});

test("evaluation tokens require exact known scopes and no user or admin privileges", (t) => {
  const { service, actor, projectId, environmentId } = fixture(t);
  const admin = actor(SEED_TOKENS.admin, "admin");
  const valid = {
    name: "Learning SDK",
    type: "client",
    scopes: ["evaluate"],
    projectIds: [projectId],
    environmentIds: [environmentId],
  };
  for (const changes of [
    { scopes: ["evaluate", "write"] },
    { userId: "usr_member" },
    { projectIds: [] },
    { environmentIds: ["unknown"] },
    { scopes: "evaluate" },
  ]) {
    assert.throws(() => service.createToken(admin, { ...valid, ...changes }));
  }
  const created = service.createToken(admin, valid);
  const evaluated = service.evaluateClient(
    { authorization: `Bearer ${created.plaintext}` },
    { context: { userId: "a" } },
  );
  assert.equal(evaluated.project, "checkout");
});

test("revoking the last administrator token is refused; a replacement allows rotation", (t) => {
  const { service, actor, store } = fixture(t);
  const admin = actor(SEED_TOKENS.admin, "admin");
  assert.throws(
    () => service.revokeToken(admin, admin.token.id),
    /another active administrator/,
  );
  const replacement = service.createToken(admin, {
    name: "Replacement",
    type: "personal",
    userId: admin.user.id,
    scopes: ["read", "write", "admin"],
    projectIds: [],
    environmentIds: [],
  });
  service.revokeToken(admin, admin.token.id);
  assert.throws(() => actor(), /Invalid token/);
  assert.equal(actor(replacement.plaintext, "admin").user.id, admin.user.id);
  assert.ok(
    store.getState().apiTokens.find((item) => item.id === admin.token.id)
      .revokedAt,
  );
});

test("token collection limits are enforced before issuing credentials", (t) => {
  const { service, actor } = fixture(t, (state) => {
    state.resourceLimits.maxTokens = state.apiTokens.length;
  });
  const admin = actor(SEED_TOKENS.admin, "admin");
  assert.throws(
    () =>
      service.createToken(admin, {
        name: "Over limit",
        type: "personal",
        userId: admin.user.id,
        scopes: ["read"],
      }),
    /Token limit/,
  );
});
