import test from "node:test";
import assert from "node:assert/strict";
import { serviceFixture } from "./fixtures.js";

test("an unreferenced project can be created, renamed and deleted while audit survives", (t) => {
  const { service, admin, store, development, production } = serviceFixture(t);
  const input = {
    name: "Training",
    key: "training",
    environmentIds: [development.id, production.id],
  };
  assert.throws(
    () => service.createProject(admin, input),
    /requires confirmation/,
  );
  const project = service.createProject(admin, {
    ...input,
    confirmation: ["CONFIRM:production"],
  });
  assert.equal(
    service.updateProject(admin, project.id, { name: "Renamed" }).name,
    "Renamed",
  );
  service.deleteProject(admin, project.id, {
    confirmation: "CONFIRM:production",
  });
  const state = store.getState();
  assert.ok(!state.projects.some((item) => item.id === project.id));
  assert.ok(
    !state.projectMembers.some((item) => item.projectId === project.id),
  );
  assert.ok(
    !state.projectEnvironments.some((item) => item.projectId === project.id),
  );
  assert.ok(
    state.auditLogs.some(
      (item) =>
        item.action === "project.deleted" && item.projectId === project.id,
    ),
  );
});

test("environment updates and deletion respect existing protection", (t) => {
  const { service, admin, store } = serviceFixture(t);
  const environment = service.createEnvironment(admin, {
    name: "Training",
    key: "training",
    type: "test",
    protectChanges: false,
  });
  service.updateEnvironment(admin, environment.id, {
    name: "Training protected",
    protectChanges: true,
  });
  assert.throws(
    () =>
      service.updateEnvironment(admin, environment.id, {
        protectChanges: false,
      }),
    /requires confirmation/,
  );
  assert.throws(
    () => service.deleteEnvironment(admin, environment.id),
    /requires confirmation/,
  );
  service.deleteEnvironment(admin, environment.id, {
    confirmation: "CONFIRM:training",
  });
  assert.ok(
    !store.getState().environments.some((item) => item.id === environment.id),
  );
  assert.throws(
    () =>
      service.createEnvironment(admin, {
        name: "Unsafe",
        key: "unsafe",
        type: "production",
        protectChanges: false,
      }),
    /must protect/,
  );
});

test("flag patch preserves omitted fields and deletion removes owned configuration", (t) => {
  const { service, admin, store, development, createFlag } = serviceFixture(t);
  const flag = createFlag("training", {
    description: "Before",
    impressionData: true,
  });
  const updated = service.updateFlag(admin, flag.id, {
    description: "",
    impressionData: false,
  });
  assert.equal(updated.name, "training");
  assert.equal(updated.description, "");
  assert.equal(updated.impressionData, false);
  const strategy = service.createStrategy(admin, {
    flagId: flag.id,
    environmentId: development.id,
    type: "enabled_for_all",
    variants: [
      { name: "a", weight: 50 },
      { name: "b", weight: 50 },
    ],
  });
  assert.throws(() => service.deleteFlag(admin, flag.id), /Archive/);
  service.updateFlag(admin, flag.id, { archived: true });
  service.deleteFlag(admin, flag.id);
  const state = store.getState();
  assert.ok(
    !state.featureFlagEnvironments.some((item) => item.flagId === flag.id),
  );
  assert.ok(!state.strategies.some((item) => item.flagId === flag.id));
  assert.ok(!state.variants.some((item) => item.strategyId === strategy.id));
  assert.equal(
    state.auditLogs.find((item) => item.action === "flag.deleted").before
      .strategies.length,
    1,
  );
});

test("dependencies prevent deletion until detached and duplicate edges are refused", (t) => {
  const { service, admin, createFlag } = serviceFixture(t);
  const parent = createFlag("parent"),
    child = createFlag("child");
  const input = { parentFlagId: parent.id, childFlagId: child.id };
  const dependency = service.createDependency(admin, input);
  assert.throws(() => service.createDependency(admin, input), /already exists/);
  assert.throws(
    () =>
      service.createDependency(admin, {
        parentFlagId: child.id,
        childFlagId: parent.id,
      }),
    /cycle/,
  );
  service.updateFlag(admin, parent.id, { archived: true });
  assert.throws(() => service.deleteFlag(admin, parent.id), /dependencies/);
  service.deleteDependency(admin, dependency.id);
  assert.equal(service.deleteFlag(admin, parent.id).deleted, true);
});

test("segment references must exist and belong to the same project or global scope", (t) => {
  const { service, admin, createFlag, development } = serviceFixture(
    t,
    (state) => {
      state.projects.push({
        ...state.projects[0],
        id: "prj_other",
        key: "other",
      });
      state.segments.push({
        id: "seg_other",
        name: "Other",
        projectId: "prj_other",
        constraints: [],
      });
    },
  );
  const flag = createFlag("training");
  for (const segmentId of ["seg_missing", "seg_other"])
    assert.throws(
      () =>
        service.createStrategy(admin, {
          flagId: flag.id,
          environmentId: development.id,
          type: "enabled_for_all",
          segmentIds: [segmentId],
        }),
      /must exist in this project/,
    );
});

test("referenced segment edits require protected environment confirmation and delete requires detachment", (t) => {
  const { service, admin, store } = serviceFixture(t);
  const segment = store.getState().segments[0];
  const strategy = store
    .getState()
    .strategies.find((item) => item.segmentIds.includes(segment.id));
  assert.throws(
    () => service.updateSegment(admin, segment.id, { name: "Renamed" }),
    /requires confirmation/,
  );
  service.updateSegment(admin, segment.id, {
    name: "Renamed",
    confirmation: "CONFIRM:production",
  });
  assert.throws(() => service.deleteSegment(admin, segment.id), /Detach/);
  service.updateStrategy(admin, strategy.id, {
    segmentIds: [],
    confirmation: "CONFIRM:production",
  });
  assert.equal(service.deleteSegment(admin, segment.id).deleted, true);
});

test("owner transfer updates membership and refuses unknown users without partial writes", (t) => {
  const { service, admin, store, projectId } = serviceFixture(t, (state) => {
    state.users.push({
      id: "usr_new",
      name: "New owner",
      email: "new@example.invalid",
      roles: ["project_member"],
    });
  });
  const before = store.getState().projects[0].name;
  assert.throws(
    () =>
      service.updateProject(admin, projectId, {
        name: "Should roll back",
        ownerUserId: "usr_unknown",
      }),
    /active user/,
  );
  assert.equal(store.getState().projects[0].name, before);
  service.updateProject(admin, projectId, { ownerUserId: "usr_new" });
  const state = store.getState();
  assert.equal(state.projects[0].ownerUserId, "usr_new");
  assert.equal(
    state.projectMembers.find(
      (item) => item.projectId === projectId && item.userId === "usr_new",
    ).role,
    "project_owner",
  );
  assert.equal(
    state.projectMembers.find(
      (item) => item.projectId === projectId && item.userId === admin.user.id,
    ).role,
    "project_member",
  );
});

test("project environment and environment deletion cannot strand references", (t) => {
  const { service, admin, projectId, development, production } =
    serviceFixture(t);
  assert.throws(
    () =>
      service.updateProject(admin, projectId, {
        environmentIds: [development.id],
        confirmation: "CONFIRM:production",
      }),
    /references/,
  );
  assert.throws(
    () =>
      service.deleteEnvironment(admin, production.id, {
        confirmation: "CONFIRM:production",
      }),
    /references/,
  );
  assert.throws(
    () =>
      service.deleteProject(admin, projectId, {
        confirmation: "CONFIRM:production",
      }),
    /references/,
  );
});

test("variant CRUD preserves totals and strategy deletion removes its variants", (t) => {
  const { service, admin, createFlag, development, store } = serviceFixture(t);
  const flag = createFlag("training");
  const strategy = service.createStrategy(admin, {
    flagId: flag.id,
    environmentId: development.id,
    type: "enabled_for_all",
  });
  const first = service.createVariant(admin, {
    strategyId: strategy.id,
    name: "main",
    weight: 100,
  });
  const second = service.createVariant(admin, {
    strategyId: strategy.id,
    name: "unused",
    weight: 0,
  });
  assert.throws(
    () => service.updateVariant(admin, first.id, { weight: 50 }),
    /sum to 100/,
  );
  assert.equal(
    service.updateVariant(admin, second.id, { name: "renamed" }).name,
    "renamed",
  );
  service.deleteVariant(admin, second.id);
  service.deleteStrategy(admin, strategy.id);
  assert.ok(
    !store.getState().variants.some((item) => item.strategyId === strategy.id),
  );
});

test("protected flag edits and lifecycle actions require explicit acknowledgment", (t) => {
  const { service, admin, store } = serviceFixture(t);
  const flag = store.getState().featureFlags[0];
  assert.throws(
    () => service.updateFlag(admin, flag.id, { name: "Renamed" }),
    /requires confirmation/,
  );
  assert.throws(
    () => service.changeFlagLifecycle(admin, flag.id, "archive"),
    /requires confirmation/,
  );
  assert.equal(
    service.changeFlagLifecycle(admin, flag.id, "archive", {
      confirmation: "CONFIRM:production",
    }).archived,
    true,
  );
});

test("direct service reuse refreshes revoked actors and enforces read-only scopes", (t) => {
  const { service, admin, actor, store, createFlag } = serviceFixture(t);
  const issued = service.createToken(admin, {
    name: "Read only",
    type: "personal",
    userId: admin.user.id,
    scopes: ["read"],
  });
  const reader = actor(issued.plaintext);
  assert.ok(service.listFlags(reader).length > 0);
  assert.throws(
    () =>
      service.updateProject(reader, store.getState().projects[0].id, {
        name: "Forbidden",
      }),
    /write.*scope/,
  );
  service.revokeToken(admin, issued.id);
  assert.throws(() => service.listFlags(reader), /Invalid token/);
  assert.ok(createFlag("still_authorized"));
});

test("flag limits reject new records without mutating state", (t) => {
  const { store, createFlag } = serviceFixture(t, (state) => {
    state.resourceLimits.maxFlagsPerProject = state.featureFlags.length;
  });
  const version = store.getState().meta.version;
  assert.throws(() => createFlag("over_limit"), /Flag limit/);
  assert.equal(store.getState().meta.version, version);
});

test("variants inherit a custom stickiness field consistently", (t) => {
  const { service, admin, createFlag, development } = serviceFixture(t);
  const flag = createFlag("custom_stickiness");
  const strategy = service.createStrategy(admin, {
    flagId: flag.id,
    environmentId: development.id,
    type: "gradual_rollout",
    parameters: { rollout: 100, stickiness: "deviceId" },
    variants: [{ name: "main", weight: 100, stickiness: "deviceId" }],
  });
  const extra = service.createVariant(admin, {
    strategyId: strategy.id,
    name: "unused",
    weight: 0,
  });
  assert.equal(extra.stickiness, "deviceId");
  assert.throws(
    () =>
      service.createVariant(admin, {
        strategyId: strategy.id,
        name: "mismatched",
        weight: 0,
        stickiness: "userId",
      }),
    /same stickiness/,
  );
});
