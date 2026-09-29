import crypto from "node:crypto";

import {
  DEFAULT_RESOURCE_LIMITS,
  FLAG_TYPES,
  INSTANCE_ROLES,
  TOKEN_SCOPES,
  TOKEN_TYPES,
  PERMISSIONS,
} from "../core/constants.js";
import { evaluateSnapshot } from "../core/evaluation.js";
import { createId, hashToken } from "../core/hash.js";
import {
  validateOperation,
  validateStrategySettings,
  validateVariant,
  validateEvaluationContext,
  validateMetricsInput,
} from "./contracts.js";

function createError(status, message, details = {}) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function assert(condition, status, message, details) {
  if (!condition) {
    throw createError(status, message, details);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function getProject(state, projectId) {
  return state.projects.find((item) => item.id === projectId);
}

function getEnvironment(state, environmentId) {
  return state.environments.find((item) => item.id === environmentId);
}

function getFlag(state, flagId) {
  return state.featureFlags.find((item) => item.id === flagId);
}

function getProjectMembership(state, userId, projectId) {
  return state.projectMembers.find(
    (member) => member.userId === userId && member.projectId === projectId,
  );
}

function getActorFromToken(state, rawToken) {
  assert(
    typeof rawToken === "string" &&
      rawToken.length > 0 &&
      rawToken.length <= 512,
    401,
    "Invalid token",
  );
  const token = state.apiTokens.find(
    (item) => item.hash === hashToken(rawToken) && item.revokedAt === null,
  );
  if (!token) {
    throw createError(401, "Invalid token");
  }
  return actorFromRecord(state, token);
}

function actorFromRecord(state, token) {
  const user = token.userId
    ? state.users.find((item) => item.id === token.userId)
    : null;
  assert(
    TOKEN_TYPES.includes(token.type) && Array.isArray(token.scopes),
    401,
    "Invalid token",
  );
  assert(
    token.scopes.every((scope) => TOKEN_SCOPES.includes(scope)) &&
      new Set(token.scopes).size === token.scopes.length &&
      Array.isArray(token.projectIds) &&
      Array.isArray(token.environmentIds),
    401,
    "Invalid token scopes",
  );
  if (token.expiresAt != null)
    assert(
      typeof token.expiresAt === "string" &&
        Number.isFinite(Date.parse(token.expiresAt)) &&
        Date.parse(token.expiresAt) > Date.now(),
      401,
      "Token expired",
    );
  if (token.type === "personal")
    assert(
      user && user.active !== false && Array.isArray(user.roles),
      401,
      "Inactive token user",
    );
  else
    assert(
      token.userId == null &&
        token.scopes.length === 1 &&
        token.scopes[0] === "evaluate",
      401,
      "Invalid evaluation token identity or scopes",
    );
  return { token, user };
}

function requireScope(actor, scope) {
  assert(
    actor.token.scopes.includes(scope),
    403,
    `Token is missing "${scope}" scope`,
  );
}

function requireAdminRole(actor) {
  if (!actor.user || actor.token.type !== "personal") {
    throw createError(403, "This route requires a personal access token");
  }
  const roles = actor.user.roles ?? [];
  assert(
    roles.some((role) => INSTANCE_ROLES.includes(role)),
    403,
    "User does not have an admin role",
  );
}

function requireInstanceAdmin(actor) {
  requireAdminRole(actor);
  requireScope(actor, "admin");
  assert(
    actor.user.roles.includes("instance_admin"),
    403,
    "Instance administrator required",
  );
}

function canReadProject(state, actor, projectId) {
  if (!actor.user) {
    return false;
  }
  if (
    actor.user.roles.includes("instance_admin") ||
    actor.user.roles.includes("viewer")
  ) {
    return true;
  }
  return Boolean(getProjectMembership(state, actor.user.id, projectId));
}

function canWriteProject(state, actor, projectId) {
  if (!actor.user) {
    return false;
  }
  if (actor.user.roles.includes("instance_admin")) {
    return true;
  }
  if (
    !actor.user.roles.some((role) =>
      ["project_owner", "project_member"].includes(role),
    )
  )
    return false;
  const membership = getProjectMembership(state, actor.user.id, projectId);
  return (
    membership && ["project_owner", "project_member"].includes(membership.role)
  );
}

function requireProjectRead(state, actor, projectId) {
  requireScope(actor, "read");
  assert(getProject(state, projectId), 404, "Project not found");
  assert(
    canReadProject(state, actor, projectId),
    403,
    "Project read access denied",
  );
}

function requireProjectWrite(state, actor, projectId) {
  requireScope(actor, "write");
  assert(getProject(state, projectId), 404, "Project not found");
  assert(
    canWriteProject(state, actor, projectId),
    403,
    "Project write access denied",
  );
}

function auditProjectId(state, entry) {
  if (entry.projectId) return entry.projectId;
  if (entry.resourceType === "project") return entry.resourceId;
  const value = entry.after || entry.before || {};
  if (value.projectId) return value.projectId;
  const strategy =
    entry.resourceType === "variant"
      ? state.strategies.find((item) => item.id === value.strategyId)
      : value;
  const flagId =
    entry.resourceType === "flag" ? entry.resourceId : strategy?.flagId;
  return (
    state.featureFlags.find((item) => item.id === flagId)?.projectId ?? null
  );
}

function visibleAudit(state, actor, projectId = null) {
  return state.auditLogs.filter((entry) => {
    const related = auditProjectId(state, entry);
    if (projectId)
      return related === projectId && canReadProject(state, actor, projectId);
    return (
      actor.user.roles.includes("instance_admin") ||
      (related && canReadProject(state, actor, related))
    );
  });
}

function appendAudit(
  state,
  { actor, action, resourceType, resourceId, before, after, metadata },
) {
  state.auditLogs.unshift({
    id: createId("audit"),
    actorTokenId: actor?.token?.id ?? null,
    actorUserId: actor?.user?.id ?? null,
    action,
    resourceType,
    resourceId,
    projectId: auditProjectId(state, {
      resourceType,
      resourceId,
      before,
      after,
    }),
    before,
    after,
    metadata: metadata ?? {},
    createdAt: nowIso(),
  });
}

function assertUniqueFlagKey(state, key, ignoreFlagId = null) {
  const collision = state.featureFlags.find(
    (flag) => flag.key === key && flag.id !== ignoreFlagId,
  );
  assert(!collision, 409, `Flag key "${key}" already exists`);
}

function assertProjectEnvironmentSelection(state, environmentIds) {
  assert(
    environmentIds.length > 0,
    400,
    "Each project must keep at least one active environment",
  );
  for (const environmentId of environmentIds) {
    assert(
      getEnvironment(state, environmentId),
      400,
      `Unknown environment "${environmentId}"`,
    );
  }
}

function assertProtectedEnvironmentConfirmation(
  state,
  environmentId,
  confirmation,
) {
  const environment = getEnvironment(state, environmentId);
  if (environment?.protectChanges) {
    assert(
      (Array.isArray(confirmation) ? confirmation : [confirmation]).includes(
        `CONFIRM:${environment.key}`,
      ),
      409,
      `Protected environment "${environment.key}" requires confirmation`,
    );
  }
}

function confirmFlagChanges(state, flagId, confirmation) {
  for (const mapping of state.featureFlagEnvironments.filter(
    (item) => item.flagId === flagId,
  )) {
    assertProtectedEnvironmentConfirmation(
      state,
      mapping.environmentId,
      confirmation,
    );
  }
}

function assertSegmentsBelongToProject(state, segmentIds, projectId) {
  for (const id of segmentIds) {
    const segment = state.segments.find((item) => item.id === id);
    assert(
      segment &&
        (segment.projectId === null || segment.projectId === projectId),
      422,
      "Strategy segments must exist in this project or be shared globally",
    );
  }
}

function assertVariantWeights(variants = []) {
  if (variants.length === 0) {
    return;
  }
  assert(
    variants.every(
      (variant) =>
        Number.isInteger(variant.weight) &&
        variant.weight >= 0 &&
        variant.weight <= 100,
    ),
    422,
    "Variant weights must be integers from 0 to 100",
  );
  assert(
    new Set(variants.map((variant) => variant.name)).size === variants.length,
    409,
    "Variant names must be unique within the strategy",
  );
  assert(
    new Set(variants.map((variant) => variant.stickiness ?? "userId")).size <=
      1,
    422,
    "Variants in a strategy must use the same stickiness field",
  );
  const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
  assert(total === 100, 400, "Variant weights must sum to 100");
}

function assertSiblingVariantWeights(
  state,
  strategyId,
  candidate,
  ignoreVariantId = null,
) {
  const siblings = state.variants.filter(
    (variant) =>
      variant.strategyId === strategyId && variant.id !== ignoreVariantId,
  );
  assertVariantWeights([...siblings, candidate]);
}

function detectDependencyCycle(state, projectId, parentFlagId, childFlagId) {
  const adjacency = new Map();
  for (const dependency of state.flagDependencies.filter(
    (item) => item.projectId === projectId,
  )) {
    const edges = adjacency.get(dependency.parentFlagId) ?? [];
    edges.push(dependency.childFlagId);
    adjacency.set(dependency.parentFlagId, edges);
  }

  const edges = adjacency.get(parentFlagId) ?? [];
  adjacency.set(parentFlagId, [...edges, childFlagId]);

  const stack = [childFlagId];
  const visited = new Set();

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === parentFlagId) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      stack.push(next);
    }
  }

  return false;
}

function serializeFlag(state, flag) {
  const project = getProject(state, flag.projectId);
  const environments = state.featureFlagEnvironments
    .filter((mapping) => mapping.flagId === flag.id)
    .map((mapping) => getEnvironment(state, mapping.environmentId))
    .filter(Boolean);
  const strategies = state.strategies
    .filter((strategy) => strategy.flagId === flag.id)
    .map((strategy) => ({
      ...strategy,
      variants: state.variants.filter(
        (variant) => variant.strategyId === strategy.id,
      ),
      environment: getEnvironment(state, strategy.environmentId),
    }));
  const dependencies = state.flagDependencies.filter(
    (dependency) => dependency.childFlagId === flag.id,
  );
  return {
    ...flag,
    project,
    environments,
    strategies,
    dependencies,
  };
}

function filterFlags(state, query) {
  return state.featureFlags
    .filter((flag) => !query.projectId || flag.projectId === query.projectId)
    .filter((flag) => !query.type || flag.type === query.type)
    .filter((flag) => query.stale === undefined || flag.stale === query.stale)
    .filter(
      (flag) =>
        query.archived === undefined || flag.archived === query.archived,
    )
    .map((flag) => serializeFlag(state, flag));
}

function issuePlaintextToken() {
  return crypto.randomBytes(18).toString("hex");
}

function readTokenFromHeaders(headers) {
  const authorization = headers.authorization || "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;
}

export function createPlatformService(store) {
  const service = {
    getActorFromHeaders(headers, requiredScope = "read") {
      const tokenValue = readTokenFromHeaders(headers);
      assert(tokenValue, 401, "Missing Bearer token");
      const actor = getActorFromToken(store.getState(), tokenValue);
      requireScope(actor, requiredScope);
      return actor;
    },

    listProjects(actor) {
      requireAdminRole(actor);
      const state = store.getState();
      return state.projects
        .filter((project) => canReadProject(state, actor, project.id))
        .map((project) => ({
          ...project,
          membershipRole:
            getProjectMembership(state, actor.user.id, project.id)?.role ??
            null,
          environments: state.projectEnvironments
            .filter((mapping) => mapping.projectId === project.id)
            .map((mapping) => ({
              ...getEnvironment(state, mapping.environmentId),
              defaultStrategy: mapping.defaultStrategy,
            })),
        }));
    },

    createProject(actor, input) {
      requireInstanceAdmin(actor);
      const state = store.getState();
      const limits = state.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
      assert(
        state.projects.length < limits.maxProjects,
        409,
        "Project limit reached",
      );
      assert(input.name && input.key, 400, "Project name and key are required");
      assert(
        !state.projects.some((project) => project.key === input.key),
        409,
        `Project key "${input.key}" already exists`,
      );
      const ownerUserId = input.ownerUserId || actor.user.id;
      assert(
        state.users.some(
          (user) =>
            user.id === ownerUserId &&
            user.active !== false &&
            user.roles.some((role) =>
              ["instance_admin", "project_owner", "project_member"].includes(
                role,
              ),
            ),
        ),
        422,
        "Owner must be an active user with a writable role",
      );
      assertProjectEnvironmentSelection(state, input.environmentIds ?? []);
      for (const environmentId of input.environmentIds)
        assertProtectedEnvironmentConfirmation(
          state,
          environmentId,
          input.confirmation,
        );
      for (const environmentId of Object.keys(input.defaultStrategies ?? {}))
        assert(
          input.environmentIds.includes(environmentId),
          422,
          "Default strategies must belong to selected environments",
        );

      return store.mutate((draft) => {
        const now = nowIso();
        const project = {
          id: createId("prj"),
          key: input.key,
          name: input.name,
          description: input.description || "",
          ownerUserId,
          createdAt: now,
          updatedAt: now,
        };
        draft.projects.push(project);
        draft.projectMembers.push({
          id: createId("mem"),
          projectId: project.id,
          userId: ownerUserId,
          role: "project_owner",
          createdAt: now,
        });
        for (const environmentId of input.environmentIds) {
          draft.projectEnvironments.push({
            id: createId("pe"),
            projectId: project.id,
            environmentId,
            defaultStrategy: input.defaultStrategies?.[environmentId] ?? {
              type: "disabled",
              name: "Default",
              parameters: {},
              constraints: [],
            },
            createdAt: now,
          });
        }
        appendAudit(draft, {
          actor,
          action: "project.created",
          resourceType: "project",
          resourceId: project.id,
          before: null,
          after: project,
        });
        return project;
      });
    },

    updateProject(actor, projectId, input) {
      requireAdminRole(actor);
      const state = store.getState();
      requireProjectWrite(state, actor, projectId);

      return store.mutate((draft) => {
        const project = getProject(draft, projectId);
        assert(project, 404, "Project not found");
        const before = structuredClone(project);
        if (input.name) project.name = input.name;
        if (input.description !== undefined)
          project.description = input.description;
        if (input.ownerUserId && input.ownerUserId !== project.ownerUserId) {
          assert(
            actor.user.roles.includes("instance_admin") ||
              getProjectMembership(draft, actor.user.id, projectId)?.role ===
                "project_owner",
            403,
            "Only the project owner or instance administrator can transfer ownership",
          );
          assert(
            draft.users.some(
              (user) =>
                user.id === input.ownerUserId &&
                user.active !== false &&
                user.roles.some((role) =>
                  [
                    "instance_admin",
                    "project_owner",
                    "project_member",
                  ].includes(role),
                ),
            ),
            422,
            "Owner must be an active user with a writable role",
          );
          const previous = getProjectMembership(
            draft,
            project.ownerUserId,
            projectId,
          );
          if (previous?.role === "project_owner")
            previous.role = "project_member";
          let next = getProjectMembership(draft, input.ownerUserId, projectId);
          if (!next) {
            next = {
              id: createId("mem"),
              projectId,
              userId: input.ownerUserId,
              createdAt: nowIso(),
            };
            draft.projectMembers.push(next);
          }
          next.role = "project_owner";
          project.ownerUserId = input.ownerUserId;
        }

        if (input.environmentIds) {
          assertProjectEnvironmentSelection(draft, input.environmentIds);
          const previousIds = draft.projectEnvironments
            .filter((item) => item.projectId === projectId)
            .map((item) => item.environmentId);
          for (const environmentId of new Set([
            ...previousIds,
            ...input.environmentIds,
          ])) {
            if (
              previousIds.includes(environmentId) ===
              input.environmentIds.includes(environmentId)
            )
              continue;
            assertProtectedEnvironmentConfirmation(
              draft,
              environmentId,
              input.confirmation,
            );
            if (!input.environmentIds.includes(environmentId)) {
              const flags = new Set(
                draft.featureFlags
                  .filter((item) => item.projectId === projectId)
                  .map((item) => item.id),
              );
              assert(
                !draft.featureFlagEnvironments.some(
                  (item) =>
                    flags.has(item.flagId) &&
                    item.environmentId === environmentId,
                ) &&
                  !draft.apiTokens.some(
                    (item) =>
                      item.projectIds.includes(projectId) &&
                      item.environmentIds.includes(environmentId),
                  ),
                409,
                "Remove flag and token references before removing a project environment",
              );
            }
          }
          draft.projectEnvironments = draft.projectEnvironments.filter(
            (item) =>
              item.projectId !== projectId ||
              input.environmentIds.includes(item.environmentId),
          );
          for (const environmentId of input.environmentIds) {
            const existing = draft.projectEnvironments.find(
              (item) =>
                item.projectId === projectId &&
                item.environmentId === environmentId,
            );
            if (!existing) {
              draft.projectEnvironments.push({
                id: createId("pe"),
                projectId,
                environmentId,
                defaultStrategy: {
                  type: "disabled",
                  name: "Default",
                  parameters: {},
                  constraints: [],
                },
                createdAt: nowIso(),
              });
            }
          }
        }

        if (input.defaultStrategies) {
          for (const [environmentId, defaultStrategy] of Object.entries(
            input.defaultStrategies,
          )) {
            assertProtectedEnvironmentConfirmation(
              draft,
              environmentId,
              input.confirmation,
            );
            const mapping = draft.projectEnvironments.find(
              (item) =>
                item.projectId === projectId &&
                item.environmentId === environmentId,
            );
            assert(mapping, 404, "Project environment not found");
            mapping.defaultStrategy = defaultStrategy;
          }
        }

        project.updatedAt = nowIso();
        appendAudit(draft, {
          actor,
          action: "project.updated",
          resourceType: "project",
          resourceId: project.id,
          before,
          after: project,
        });
        return project;
      });
    },

    listEnvironments(actor) {
      requireAdminRole(actor);
      const state = store.getState();
      if (actor.user.roles.includes("instance_admin"))
        return state.environments;
      const ids = new Set(
        state.projectEnvironments
          .filter((item) => canReadProject(state, actor, item.projectId))
          .map((item) => item.environmentId),
      );
      return state.environments.filter((item) => ids.has(item.id));
    },

    listUsers(actor) {
      requireAdminRole(actor);
      const state = store.getState();
      if (actor.user.roles.includes("instance_admin")) return state.users;
      const ids = new Set(
        state.projectMembers
          .filter((item) => canReadProject(state, actor, item.projectId))
          .map((item) => item.userId),
      );
      ids.add(actor.user.id);
      return state.users.filter((item) => ids.has(item.id));
    },

    createEnvironment(actor, input) {
      requireInstanceAdmin(actor);
      const state = store.getState();
      const limits = state.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
      assert(
        state.environments.length < limits.maxEnvironments,
        409,
        "Environment limit reached",
      );
      assert(
        input.name && input.key && input.type,
        400,
        "Environment name, key, and type are required",
      );
      assert(
        !(input.type === "production" && input.protectChanges === false),
        422,
        "Production environments must protect changes",
      );
      assert(
        !state.environments.some(
          (environment) => environment.key === input.key,
        ),
        409,
        `Environment key "${input.key}" already exists`,
      );

      return store.mutate((draft) => {
        const environment = {
          id: createId("env"),
          key: input.key,
          name: input.name,
          type: input.type,
          protectChanges: Boolean(
            input.protectChanges ?? input.type === "production",
          ),
          createdAt: nowIso(),
        };
        draft.environments.push(environment);
        appendAudit(draft, {
          actor,
          action: "environment.created",
          resourceType: "environment",
          resourceId: environment.id,
          before: null,
          after: environment,
        });
        return environment;
      });
    },

    updateEnvironment(actor, environmentId, input) {
      requireInstanceAdmin(actor);
      const state = store.getState();
      const environment = getEnvironment(state, environmentId);
      assert(environment, 404, "Environment not found");
      assertProtectedEnvironmentConfirmation(
        state,
        environmentId,
        input.confirmation,
      );
      if (input.type === "production" && input.protectChanges === false)
        throw createError(422, "Production environments must protect changes");
      if (
        environment.type === "production" &&
        input.type === undefined &&
        input.protectChanges === false
      )
        throw createError(422, "Production environments must protect changes");
      return store.mutate((draft) => {
        const target = getEnvironment(draft, environmentId);
        const before = structuredClone(target);
        for (const key of ["name", "type", "protectChanges"])
          if (Object.hasOwn(input, key)) target[key] = input[key];
        if (target.type === "production") target.protectChanges = true;
        appendAudit(draft, {
          actor,
          action: "environment.updated",
          resourceType: "environment",
          resourceId: target.id,
          before,
          after: target,
        });
        return target;
      });
    },

    listFlags(actor, query = {}) {
      requireAdminRole(actor);
      const state = store.getState();
      if (query.projectId) {
        requireProjectRead(state, actor, query.projectId);
      }
      return filterFlags(state, query).filter((flag) =>
        canReadProject(state, actor, flag.projectId),
      );
    },

    createFlag(actor, input) {
      requireAdminRole(actor);
      const state = store.getState();
      assert(
        input.projectId && input.key && input.name && input.type,
        400,
        "Missing required flag fields",
      );
      assert(FLAG_TYPES.includes(input.type), 400, "Invalid flag type");
      requireProjectWrite(state, actor, input.projectId);
      assertUniqueFlagKey(state, input.key);
      assert(
        state.featureFlags.filter((item) => item.projectId === input.projectId)
          .length < state.resourceLimits.maxFlagsPerProject,
        409,
        "Flag limit reached for this project",
      );

      const projectEnvironmentIds = state.projectEnvironments
        .filter((item) => item.projectId === input.projectId)
        .map((item) => item.environmentId);
      const targetEnvironmentIds =
        input.environmentIds && input.environmentIds.length > 0
          ? input.environmentIds
          : projectEnvironmentIds;
      for (const environmentId of targetEnvironmentIds) {
        assert(
          projectEnvironmentIds.includes(environmentId),
          400,
          "Flags can only target environments enabled for the project",
        );
        assertProtectedEnvironmentConfirmation(
          state,
          environmentId,
          input.confirmation,
        );
      }

      return store.mutate((draft) => {
        const now = nowIso();
        const flag = {
          id: createId("flag"),
          projectId: input.projectId,
          key: input.key,
          name: input.name,
          type: input.type,
          description: input.description || "",
          stale: false,
          archived: false,
          impressionData: Boolean(input.impressionData),
          createdAt: now,
          updatedAt: now,
          lastSeenAt: null,
        };
        draft.featureFlags.push(flag);
        for (const environmentId of targetEnvironmentIds) {
          draft.featureFlagEnvironments.push({
            id: createId("ffe"),
            flagId: flag.id,
            environmentId,
            createdAt: now,
          });
        }
        appendAudit(draft, {
          actor,
          action: "flag.created",
          resourceType: "flag",
          resourceId: flag.id,
          before: null,
          after: flag,
        });
        return serializeFlag(draft, flag);
      });
    },

    updateFlag(actor, flagId, input) {
      requireAdminRole(actor);
      const state = store.getState();
      const flag = getFlag(state, flagId);
      assert(flag, 404, "Flag not found");
      requireProjectWrite(state, actor, flag.projectId);
      confirmFlagChanges(state, flagId, input.confirmation);

      return store.mutate((draft) => {
        const target = getFlag(draft, flagId);
        const before = structuredClone(target);
        if (input.key && input.key !== target.key) {
          assertUniqueFlagKey(draft, input.key, flagId);
          target.key = input.key;
        }
        if (input.name) target.name = input.name;
        if (input.description !== undefined)
          target.description = input.description;
        if (input.type) target.type = input.type;
        if (input.stale !== undefined) target.stale = Boolean(input.stale);
        if (input.archived !== undefined)
          target.archived = Boolean(input.archived);
        if (input.impressionData !== undefined) {
          target.impressionData = Boolean(input.impressionData);
        }
        target.updatedAt = nowIso();
        appendAudit(draft, {
          actor,
          action: "flag.updated",
          resourceType: "flag",
          resourceId: target.id,
          before,
          after: target,
        });
        return serializeFlag(draft, target);
      });
    },

    changeFlagLifecycle(actor, flagId, action, input = {}) {
      const updates = {
        stale: { stale: true },
        archive: { archived: true },
        unarchive: { archived: false },
      };
      assert(Object.hasOwn(updates, action), 400, "Unknown lifecycle action");
      return this.updateFlag(actor, flagId, {
        ...updates[action],
        confirmation: input.confirmation ?? [],
      });
    },

    createSegment(actor, input) {
      requireAdminRole(actor);
      const state = store.getState();
      if (input.projectId) {
        requireProjectWrite(state, actor, input.projectId);
      } else requireInstanceAdmin(actor);
      const limits = state.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
      assert(
        state.segments.length < limits.maxSegments,
        409,
        "Segment limit reached",
      );
      assert(input.name, 400, "Segment name is required");
      assert(
        !state.segments.some(
          (item) =>
            item.projectId === (input.projectId ?? null) &&
            item.name.toLowerCase() === input.name.toLowerCase(),
        ),
        409,
        "Segment name already exists in this scope",
      );

      return store.mutate((draft) => {
        const segment = {
          id: createId("seg"),
          name: input.name,
          description: input.description || "",
          projectId: input.projectId ?? null,
          constraints: input.constraints ?? [],
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        draft.segments.push(segment);
        appendAudit(draft, {
          actor,
          action: "segment.created",
          resourceType: "segment",
          resourceId: segment.id,
          before: null,
          after: segment,
        });
        return segment;
      });
    },

    updateSegment(actor, segmentId, input) {
      requireAdminRole(actor);
      const state = store.getState();
      const segment = state.segments.find((item) => item.id === segmentId);
      assert(segment, 404, "Segment not found");
      if (segment.projectId) {
        requireProjectWrite(state, actor, segment.projectId);
      } else requireInstanceAdmin(actor);
      if (input.name)
        assert(
          !state.segments.some(
            (item) =>
              item.id !== segmentId &&
              item.projectId === segment.projectId &&
              item.name.toLowerCase() === input.name.toLowerCase(),
          ),
          409,
          "Segment name already exists in this scope",
        );
      for (const strategy of state.strategies.filter((item) =>
        item.segmentIds.includes(segmentId),
      )) {
        assertProtectedEnvironmentConfirmation(
          state,
          strategy.environmentId,
          input.confirmation,
        );
      }

      return store.mutate((draft) => {
        const target = draft.segments.find((item) => item.id === segmentId);
        const before = structuredClone(target);
        if (input.name) target.name = input.name;
        if (input.description !== undefined)
          target.description = input.description;
        if (input.constraints) target.constraints = input.constraints;
        target.updatedAt = nowIso();
        appendAudit(draft, {
          actor,
          action: "segment.updated",
          resourceType: "segment",
          resourceId: target.id,
          before,
          after: target,
        });
        return target;
      });
    },

    createStrategy(actor, input) {
      requireAdminRole(actor);
      const state = store.getState();
      const flag = getFlag(state, input.flagId);
      assert(flag, 404, "Flag not found");
      requireProjectWrite(state, actor, flag.projectId);
      assertProtectedEnvironmentConfirmation(
        state,
        input.environmentId,
        input.confirmation,
      );
      assertSegmentsBelongToProject(
        state,
        input.segmentIds ?? [],
        flag.projectId,
      );
      assertVariantWeights(
        input.variants?.map((item) => ({
          ...item,
          stickiness:
            item.stickiness ?? input.parameters?.stickiness ?? "userId",
        })),
      );

      const envMapping = state.featureFlagEnvironments.find(
        (item) =>
          item.flagId === input.flagId &&
          item.environmentId === input.environmentId,
      );
      assert(envMapping, 400, "Flag is not enabled in that environment");
      const currentStrategies = state.strategies.filter(
        (strategy) =>
          strategy.flagId === input.flagId &&
          strategy.environmentId === input.environmentId,
      );
      const limits = state.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
      assert(
        currentStrategies.length < limits.maxStrategiesPerFlagEnvironment,
        409,
        "Strategy limit reached for this flag/environment",
      );

      return store.mutate((draft) => {
        const now = nowIso();
        const strategy = {
          id: createId("str"),
          flagId: input.flagId,
          environmentId: input.environmentId,
          name: input.name || input.type,
          type: input.type,
          parameters: input.parameters ?? {},
          constraints: input.constraints ?? [],
          segmentIds: input.segmentIds ?? [],
          sortOrder: input.sortOrder ?? currentStrategies.length + 1,
          createdAt: now,
          updatedAt: now,
        };
        draft.strategies.push(strategy);
        for (const variantInput of input.variants ?? []) {
          draft.variants.push({
            id: createId("var"),
            strategyId: strategy.id,
            name: variantInput.name,
            weight: variantInput.weight,
            stickiness:
              variantInput.stickiness ||
              input.parameters?.stickiness ||
              "userId",
            payloadType: variantInput.payloadType || "string",
            payload: variantInput.payload ?? "",
            createdAt: now,
          });
        }
        appendAudit(draft, {
          actor,
          action: "strategy.created",
          resourceType: "strategy",
          resourceId: strategy.id,
          before: null,
          after: {
            ...strategy,
            variants: draft.variants.filter(
              (variant) => variant.strategyId === strategy.id,
            ),
          },
        });
        return {
          ...strategy,
          variants: draft.variants.filter(
            (variant) => variant.strategyId === strategy.id,
          ),
        };
      });
    },

    updateStrategy(actor, strategyId, input) {
      requireAdminRole(actor);
      const state = store.getState();
      const strategy = state.strategies.find((item) => item.id === strategyId);
      assert(strategy, 404, "Strategy not found");
      validateStrategySettings({ ...strategy, ...input });
      const flag = getFlag(state, strategy.flagId);
      requireProjectWrite(state, actor, flag.projectId);
      assertProtectedEnvironmentConfirmation(
        state,
        strategy.environmentId,
        input.confirmation,
      );
      assertSegmentsBelongToProject(
        state,
        input.segmentIds ?? strategy.segmentIds,
        flag.projectId,
      );
      if (input.variants) {
        assertVariantWeights(
          input.variants.map((item) => ({
            ...item,
            stickiness:
              item.stickiness ??
              input.parameters?.stickiness ??
              strategy.parameters?.stickiness ??
              "userId",
          })),
        );
      }

      return store.mutate((draft) => {
        const target = draft.strategies.find((item) => item.id === strategyId);
        const before = {
          ...structuredClone(target),
          variants: draft.variants.filter(
            (variant) => variant.strategyId === strategyId,
          ),
        };
        if (input.name) target.name = input.name;
        if (input.type) target.type = input.type;
        if (input.parameters) target.parameters = input.parameters;
        if (input.constraints) target.constraints = input.constraints;
        if (input.segmentIds) target.segmentIds = input.segmentIds;
        if (input.sortOrder !== undefined) target.sortOrder = input.sortOrder;
        target.updatedAt = nowIso();
        if (input.variants) {
          draft.variants = draft.variants.filter(
            (variant) => variant.strategyId !== strategyId,
          );
          for (const variantInput of input.variants) {
            draft.variants.push({
              id: createId("var"),
              strategyId,
              name: variantInput.name,
              weight: variantInput.weight,
              stickiness:
                variantInput.stickiness ||
                target.parameters?.stickiness ||
                "userId",
              payloadType: variantInput.payloadType || "string",
              payload: variantInput.payload ?? "",
              createdAt: nowIso(),
            });
          }
        }
        const after = {
          ...target,
          variants: draft.variants.filter(
            (variant) => variant.strategyId === strategyId,
          ),
        };
        appendAudit(draft, {
          actor,
          action: "strategy.updated",
          resourceType: "strategy",
          resourceId: target.id,
          before,
          after,
        });
        return after;
      });
    },

    createVariant(actor, input) {
      requireAdminRole(actor);
      const state = store.getState();
      const strategy = state.strategies.find(
        (item) => item.id === input.strategyId,
      );
      assert(strategy, 404, "Strategy not found");
      const flag = getFlag(state, strategy.flagId);
      requireProjectWrite(state, actor, flag.projectId);
      assertProtectedEnvironmentConfirmation(
        state,
        strategy.environmentId,
        input.confirmation,
      );
      assertSiblingVariantWeights(state, input.strategyId, {
        ...input,
        stickiness:
          input.stickiness ?? strategy.parameters?.stickiness ?? "userId",
      });

      return store.mutate((draft) => {
        const variant = {
          id: createId("var"),
          strategyId: input.strategyId,
          name: input.name,
          weight: input.weight,
          stickiness:
            input.stickiness || strategy.parameters?.stickiness || "userId",
          payloadType: input.payloadType || "string",
          payload: input.payload ?? "",
          createdAt: nowIso(),
        };
        draft.variants.push(variant);
        appendAudit(draft, {
          actor,
          action: "variant.created",
          resourceType: "variant",
          resourceId: variant.id,
          before: null,
          after: variant,
        });
        return variant;
      });
    },

    updateVariant(actor, variantId, input) {
      requireAdminRole(actor);
      const state = store.getState();
      const variant = state.variants.find((item) => item.id === variantId);
      assert(variant, 404, "Variant not found");
      const candidate = { ...variant, ...input };
      validateVariant(
        Object.fromEntries(
          ["name", "weight", "stickiness", "payloadType", "payload"]
            .filter((key) => candidate[key] !== undefined)
            .map((key) => [key, candidate[key]]),
        ),
      );
      const strategy = state.strategies.find(
        (item) => item.id === variant.strategyId,
      );
      const flag = getFlag(state, strategy.flagId);
      requireProjectWrite(state, actor, flag.projectId);
      assertProtectedEnvironmentConfirmation(
        state,
        strategy.environmentId,
        input.confirmation,
      );
      assertSiblingVariantWeights(
        state,
        strategy.id,
        { ...variant, ...input },
        variantId,
      );

      return store.mutate((draft) => {
        const target = draft.variants.find((item) => item.id === variantId);
        const before = structuredClone(target);
        if (input.name) target.name = input.name;
        if (input.weight !== undefined) target.weight = input.weight;
        if (input.stickiness) target.stickiness = input.stickiness;
        if (input.payloadType) target.payloadType = input.payloadType;
        if (input.payload !== undefined) target.payload = input.payload;
        appendAudit(draft, {
          actor,
          action: "variant.updated",
          resourceType: "variant",
          resourceId: target.id,
          before,
          after: target,
        });
        return target;
      });
    },

    createDependency(actor, input) {
      requireAdminRole(actor);
      const state = store.getState();
      const parentFlag = getFlag(state, input.parentFlagId);
      const childFlag = getFlag(state, input.childFlagId);
      assert(parentFlag && childFlag, 404, "Dependency flags not found");
      assert(
        parentFlag.projectId === childFlag.projectId,
        400,
        "Dependencies must stay inside one project",
      );
      requireProjectWrite(state, actor, parentFlag.projectId);
      confirmFlagChanges(state, childFlag.id, input.confirmation);
      assert(
        !state.flagDependencies.some(
          (item) =>
            item.parentFlagId === input.parentFlagId &&
            item.childFlagId === input.childFlagId,
        ),
        409,
        "Dependency already exists",
      );
      assert(
        !detectDependencyCycle(
          state,
          parentFlag.projectId,
          input.parentFlagId,
          input.childFlagId,
        ),
        409,
        "Dependency would introduce a cycle",
      );

      return store.mutate((draft) => {
        const dependency = {
          id: createId("dep"),
          projectId: parentFlag.projectId,
          parentFlagId: input.parentFlagId,
          childFlagId: input.childFlagId,
          createdAt: nowIso(),
        };
        draft.flagDependencies.push(dependency);
        appendAudit(draft, {
          actor,
          action: "dependency.created",
          resourceType: "dependency",
          resourceId: dependency.id,
          before: null,
          after: dependency,
        });
        return dependency;
      });
    },

    listTokens(actor) {
      requireAdminRole(actor);
      const state = store.getState();
      return state.apiTokens
        .filter(
          (token) =>
            actor.user.roles.includes("instance_admin") ||
            token.userId === actor.user.id,
        )
        .map((token) => ({
          ...token,
          hash: undefined,
        }));
    },

    createToken(actor, input) {
      requireInstanceAdmin(actor);
      const state = store.getState();
      const limits = state.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
      assert(
        state.apiTokens.length < limits.maxTokens,
        409,
        "Token limit reached",
      );
      assert(
        typeof input.name === "string" &&
          input.name.trim().length > 0 &&
          input.name.length <= 100,
        422,
        "Token name must be 1..100 characters",
      );
      assert(
        Array.isArray(input.scopes) &&
          input.scopes.length > 0 &&
          input.scopes.length <= 4 &&
          new Set(input.scopes).size === input.scopes.length,
        422,
        "Provide distinct token scopes",
      );
      assert(
        Array.isArray(input.projectIds ?? []) &&
          Array.isArray(input.environmentIds ?? []),
        422,
        "Token scope IDs must be arrays",
      );
      assert(
        store.useRateLimit(
          `token-create:${actor.user.id}`,
          limits.tokenCreationsPerHour,
          60 * 60 * 1000,
        ),
        429,
        "Token creation rate limit exceeded",
      );
      assert(TOKEN_TYPES.includes(input.type), 400, "Invalid token type");
      for (const scope of input.scopes ?? []) {
        assert(TOKEN_SCOPES.includes(scope), 400, `Unknown scope "${scope}"`);
      }
      if (input.type === "personal") {
        const user = state.users.find(
          (item) => item.id === input.userId && item.active !== false,
        );
        assert(user, 422, "Personal tokens require an active user");
        const allowed = new Set(
          (user.roles ?? []).flatMap((role) => PERMISSIONS[role] ?? []),
        );
        assert(
          input.scopes.every((scope) => allowed.has(scope)),
          403,
          "Token scopes exceed the user's role",
        );
        assert(
          !(input.projectIds?.length || input.environmentIds?.length),
          422,
          "Personal tokens use user membership; scope evaluation with a client or frontend token",
        );
      } else {
        assert(
          input.userId == null &&
            input.scopes.length === 1 &&
            input.scopes[0] === "evaluate",
          422,
          "Client and frontend tokens are evaluation-only without a user",
        );
        assert(
          input.projectIds?.length === 1 && input.environmentIds?.length === 1,
          422,
          "Evaluation tokens require one project and one environment",
        );
        assert(
          state.projectEnvironments.some(
            (item) =>
              item.projectId === input.projectIds[0] &&
              item.environmentId === input.environmentIds[0],
          ),
          422,
          "Unknown project/environment scope",
        );
      }
      if (input.expiresAt != null)
        assert(
          typeof input.expiresAt === "string" &&
            Number.isFinite(Date.parse(input.expiresAt)) &&
            Date.parse(input.expiresAt) > Date.now(),
          422,
          "Token expiry must be a future timestamp",
        );

      const plaintext = issuePlaintextToken();
      return store.mutate((draft) => {
        const token = {
          id: createId("tok"),
          name: input.name.trim(),
          type: input.type,
          hash: hashToken(plaintext),
          scopes: input.scopes ?? ["read"],
          userId: input.userId ?? null,
          projectIds: input.projectIds ?? [],
          environmentIds: input.environmentIds ?? [],
          createdAt: nowIso(),
          revokedAt: null,
          lastUsedAt: null,
          expiresAt: input.expiresAt ?? null,
        };
        draft.apiTokens.push(token);
        appendAudit(draft, {
          actor,
          action: "token.created",
          resourceType: "token",
          resourceId: token.id,
          before: null,
          after: { ...token, hash: "[redacted]" },
        });
        return {
          id: token.id,
          name: token.name,
          type: token.type,
          scopes: token.scopes,
          plaintext,
        };
      });
    },

    revokeToken(actor, tokenId) {
      requireInstanceAdmin(actor);
      return store.mutate((draft) => {
        const token = draft.apiTokens.find((item) => item.id === tokenId);
        assert(token, 404, "Token not found");
        if (token.type === "personal" && token.scopes.includes("admin")) {
          const alternative = draft.apiTokens.some(
            (candidate) =>
              candidate.id !== token.id &&
              candidate.type === "personal" &&
              candidate.revokedAt === null &&
              candidate.scopes.includes("admin") &&
              (candidate.expiresAt == null ||
                Date.parse(candidate.expiresAt) > Date.now()) &&
              draft.users.some(
                (user) =>
                  user.id === candidate.userId &&
                  user.active !== false &&
                  user.roles.includes("instance_admin"),
              ),
          );
          assert(
            alternative,
            409,
            "Keep another active administrator token before revoking this one",
          );
        }
        const before = structuredClone(token);
        token.revokedAt = nowIso();
        appendAudit(draft, {
          actor,
          action: "token.revoked",
          resourceType: "token",
          resourceId: token.id,
          before: { ...before, hash: "[redacted]" },
          after: { ...token, hash: "[redacted]" },
        });
        return { id: token.id, revokedAt: token.revokedAt };
      });
    },

    listAudit(actor) {
      requireAdminRole(actor);
      const state = store.getState();
      return visibleAudit(state, actor).slice(0, 100);
    },

    listSegments(actor) {
      requireAdminRole(actor);
      const state = store.getState();
      return state.segments.filter(
        (segment) =>
          segment.projectId === null ||
          canReadProject(state, actor, segment.projectId),
      );
    },

    getDashboard(actor, projectId, environmentId) {
      requireAdminRole(actor);
      const state = store.getState();
      requireProjectRead(state, actor, projectId);

      const flags = state.featureFlags.filter(
        (flag) => flag.projectId === projectId,
      );
      const project = getProject(state, projectId);
      const environment = getEnvironment(state, environmentId);
      assert(
        state.projectEnvironments.some(
          (item) =>
            item.projectId === projectId &&
            item.environmentId === environmentId,
        ),
        404,
        "Project environment not found",
      );
      const recentAudit = visibleAudit(state, actor, projectId).slice(0, 10);
      const impressions = state.metricsImpressions.filter(
        (item) =>
          item.projectId === projectId && item.environmentId === environmentId,
      );

      return {
        project,
        environment,
        staleFlags: flags.filter((flag) => flag.stale).length,
        archivedFlags: flags.filter((flag) => flag.archived).length,
        missingOwners: flags.filter(() => !project.ownerUserId).length,
        evaluationTraffic: impressions.length,
        recentChanges: recentAudit,
      };
    },

    playground(actor, input) {
      requireAdminRole(actor);
      const state = store.getState();
      requireProjectRead(state, actor, input.projectId);
      const snapshot = store.getSnapshot(input.projectId, input.environmentId);
      assert(snapshot, 404, "Snapshot not found");
      return {
        snapshot: {
          id: snapshot.id,
          etag: snapshot.etag,
          generatedAt: snapshot.generatedAt,
        },
        results: evaluateSnapshot(
          snapshot,
          validateEvaluationContext(input.context),
        ),
      };
    },

    evaluateClient(headers, body) {
      const tokenValue = readTokenFromHeaders(headers);
      assert(tokenValue, 401, "Missing Bearer token");

      const state = store.getState();
      const actor = getActorFromToken(state, tokenValue);
      requireScope(actor, "evaluate");
      const projectId = actor.token.projectIds[0];
      const environmentId = actor.token.environmentIds[0];
      assert(projectId && environmentId, 403, "Evaluation token is not scoped");
      const snapshot = store.getSnapshot(projectId, environmentId);
      assert(snapshot, 404, "Snapshot not found for token scope");

      // The snapshot ETag identifies configuration, not this context's result.
      // An unchanged rollout must still be evaluated for every submitted user.
      const context = validateEvaluationContext(body.context);
      assert(
        body.debug === undefined || typeof body.debug === "boolean",
        422,
        "debug must be a boolean",
      );
      assert(
        store.useRateLimit(
          `evaluate:${actor.token.id}`,
          state.resourceLimits.evaluationRequestsPerMinute,
          60000,
        ),
        429,
        "Evaluation rate limit exceeded",
      );
      const results = evaluateSnapshot(snapshot, context);
      const trustedDebug = body.debug && actor.token.type !== "frontend";
      return {
        notModified: false,
        etag: snapshot.etag,
        project: snapshot.project.key,
        environment: snapshot.environment.key,
        flags: results.map((result) => ({
          key: result.flagKey,
          enabled: result.enabled,
          variant: result.variant,
          reasons: trustedDebug ? result.reasons : undefined,
          matchedStrategy: trustedDebug ? result.matchedStrategy : undefined,
        })),
      };
    },

    ingestMetrics(headers, input) {
      const tokenValue = readTokenFromHeaders(headers);
      assert(tokenValue, 401, "Missing Bearer token");
      const state = store.getState();
      const actor = getActorFromToken(state, tokenValue);
      requireScope(actor, "evaluate");
      input = validateMetricsInput(input);
      const projectId = actor.token.projectIds[0],
        environmentId = actor.token.environmentIds[0];
      assert(
        projectId &&
          environmentId &&
          state.projectEnvironments.some(
            (item) =>
              item.projectId === projectId &&
              item.environmentId === environmentId,
          ),
        403,
        "Metrics token must have a known project/environment scope",
      );
      assert(
        state.metricsImpressions.length + input.impressions.length <= 20000,
        409,
        "Metrics retention limit reached; archive this workspace before accepting more",
      );
      for (const impression of input.impressions) {
        assert(
          (impression.projectId === undefined ||
            impression.projectId === projectId) &&
            (impression.environmentId === undefined ||
              impression.environmentId === environmentId),
          403,
          "Impression scope differs from token scope",
        );
        const flag = getFlag(state, impression.flagId);
        assert(
          flag?.projectId === projectId &&
            state.featureFlagEnvironments.some(
              (item) =>
                item.flagId === impression.flagId &&
                item.environmentId === environmentId,
            ),
          422,
          "Impression flag is not in this token scope",
        );
        if (impression.variantName != null) {
          const strategyIds = new Set(
            state.strategies
              .filter(
                (item) =>
                  item.flagId === flag.id &&
                  item.environmentId === environmentId,
              )
              .map((item) => item.id),
          );
          assert(
            state.variants.some(
              (item) =>
                strategyIds.has(item.strategyId) &&
                item.name === impression.variantName,
            ),
            422,
            "Impression variant is not defined for this flag/environment",
          );
        }
      }
      assert(
        store.useRateLimit(`metrics:${actor.token.id}`, 300, 60000),
        429,
        "Metrics rate limit exceeded",
      );
      return store.mutate((draft) => {
        for (const impression of input.impressions) {
          draft.metricsImpressions.push({
            id: createId("imp"),
            projectId,
            environmentId,
            flagId: impression.flagId,
            enabled: impression.enabled,
            variantName: impression.variantName ?? null,
            contextHash: impression.contextHash ?? null,
            createdAt: nowIso(),
          });
        }
        return { accepted: input.impressions?.length ?? 0 };
      });
    },

    summarizeMetrics(actor, query) {
      requireAdminRole(actor);
      const state = store.getState();
      requireProjectRead(state, actor, query.projectId);
      assert(
        state.projectEnvironments.some(
          (item) =>
            item.projectId === query.projectId &&
            item.environmentId === query.environmentId,
        ),
        404,
        "Project environment not found",
      );
      const rows = state.metricsImpressions.filter(
        (item) =>
          item.projectId === query.projectId &&
          item.environmentId === query.environmentId,
      );
      const byFlag = new Map();
      for (const row of rows) {
        const summary = byFlag.get(row.flagId) ?? {
          flagId: row.flagId,
          impressions: 0,
          enabledCount: 0,
        };
        summary.impressions += 1;
        if (row.enabled) {
          summary.enabledCount += 1;
        }
        byFlag.set(row.flagId, summary);
      }
      return [...byFlag.values()];
    },
  };
  const deletions = {
    Project: ["projects", "project"],
    Environment: ["environments", "environment"],
    Flag: ["featureFlags", "flag"],
    Strategy: ["strategies", "strategy"],
    Segment: ["segments", "segment"],
    Variant: ["variants", "variant"],
    Dependency: ["flagDependencies", "dependency"],
  };
  for (const [label, [collection, resourceType]] of Object.entries(deletions)) {
    service[`delete${label}`] = function (actor, resourceId, input = {}) {
      const state = store.getState();
      const record = state[collection].find((item) => item.id === resourceId);
      assert(record, 404, `${label} not found`);
      const strategy =
        resourceType === "variant"
          ? state.strategies.find((item) => item.id === record.strategyId)
          : resourceType === "strategy"
            ? record
            : null;
      const flag = strategy
        ? getFlag(state, strategy.flagId)
        : resourceType === "flag"
          ? record
          : null;
      if (
        ["project", "environment"].includes(resourceType) ||
        (resourceType === "segment" && record.projectId === null)
      )
        requireInstanceAdmin(actor);
      else
        requireProjectWrite(state, actor, flag?.projectId ?? record.projectId);

      if (resourceType === "project") {
        assert(
          !state.featureFlags.some((item) => item.projectId === resourceId) &&
            !state.segments.some((item) => item.projectId === resourceId) &&
            !state.metricsImpressions.some(
              (item) => item.projectId === resourceId,
            ) &&
            !state.sdkClients.some((item) => item.projectId === resourceId) &&
            !state.apiTokens.some((item) =>
              item.projectIds.includes(resourceId),
            ),
          409,
          "Delete is blocked by flag, segment or token references",
        );
        for (const mapping of state.projectEnvironments.filter(
          (item) => item.projectId === resourceId,
        ))
          assertProtectedEnvironmentConfirmation(
            state,
            mapping.environmentId,
            input.confirmation,
          );
      } else if (resourceType === "environment") {
        assert(
          !state.projectEnvironments.some(
            (item) => item.environmentId === resourceId,
          ) &&
            !state.featureFlagEnvironments.some(
              (item) => item.environmentId === resourceId,
            ) &&
            !state.strategies.some(
              (item) => item.environmentId === resourceId,
            ) &&
            !state.metricsImpressions.some(
              (item) => item.environmentId === resourceId,
            ) &&
            !state.sdkClients.some(
              (item) => item.environmentId === resourceId,
            ) &&
            !state.apiTokens.some((item) =>
              item.environmentIds.includes(resourceId),
            ),
          409,
          "Delete is blocked by project, flag, strategy or token references",
        );
        assertProtectedEnvironmentConfirmation(
          state,
          resourceId,
          input.confirmation,
        );
      } else if (resourceType === "flag") {
        assert(
          record.archived === true,
          409,
          "Archive this flag before deleting it",
        );
        assert(
          !state.flagDependencies.some(
            (item) =>
              item.parentFlagId === resourceId ||
              item.childFlagId === resourceId,
          ) &&
            !state.metricsImpressions.some(
              (item) => item.flagId === resourceId,
            ),
          409,
          "Delete is blocked by dependencies or retained metrics",
        );
        confirmFlagChanges(state, resourceId, input.confirmation);
      } else if (resourceType === "segment") {
        assert(
          !state.strategies.some((item) =>
            item.segmentIds.includes(resourceId),
          ),
          409,
          "Detach this segment from strategies before deleting it",
        );
      } else if (resourceType === "dependency") {
        confirmFlagChanges(state, record.childFlagId, input.confirmation);
      } else {
        assert(
          strategy && flag,
          409,
          "Repair the missing strategy or flag reference before deleting",
        );
        assertProtectedEnvironmentConfirmation(
          state,
          strategy.environmentId,
          input.confirmation,
        );
        if (resourceType === "variant")
          assertVariantWeights(
            state.variants.filter(
              (item) =>
                item.strategyId === strategy.id && item.id !== resourceId,
            ),
          );
      }
      return store.mutate((draft) => {
        const before =
          resourceType === "flag"
            ? serializeFlag(draft, record)
            : resourceType === "strategy"
              ? {
                  ...record,
                  variants: draft.variants.filter(
                    (item) => item.strategyId === resourceId,
                  ),
                }
              : record;
        if (resourceType === "project") {
          draft.projectMembers = draft.projectMembers.filter(
            (item) => item.projectId !== resourceId,
          );
          draft.projectEnvironments = draft.projectEnvironments.filter(
            (item) => item.projectId !== resourceId,
          );
        }
        if (resourceType === "flag" || resourceType === "strategy") {
          const strategyIds = new Set(
            resourceType === "flag"
              ? draft.strategies
                  .filter((item) => item.flagId === resourceId)
                  .map((item) => item.id)
              : [resourceId],
          );
          draft.variants = draft.variants.filter(
            (item) => !strategyIds.has(item.strategyId),
          );
          draft.strategyConstraints = draft.strategyConstraints.filter(
            (item) => !strategyIds.has(item.strategyId),
          );
          if (resourceType === "flag") {
            draft.strategies = draft.strategies.filter(
              (item) => item.flagId !== resourceId,
            );
            draft.featureFlagEnvironments =
              draft.featureFlagEnvironments.filter(
                (item) => item.flagId !== resourceId,
              );
          }
        }
        if (resourceType === "segment")
          draft.segmentConstraints = draft.segmentConstraints.filter(
            (item) => item.segmentId !== resourceId,
          );
        const projectId =
          resourceType === "project"
            ? resourceId
            : (flag?.projectId ?? record.projectId ?? null);
        draft[collection] = draft[collection].filter(
          (item) => item.id !== resourceId,
        );
        appendAudit(draft, {
          actor,
          action: `${resourceType}.deleted`,
          resourceType,
          resourceId,
          before: { ...before, projectId },
          after: null,
        });
        return { id: resourceId, deleted: true };
      });
    };
  }
  // The service is also used directly by tests and local integrations. Keep
  // permission and payload checks here rather than relying only on routes.
  for (const [method, operation] of Object.entries(service)) {
    if (method === "getActorFromHeaders") continue;
    if (["evaluateClient", "ingestMetrics"].includes(method)) {
      service[method] = (...args) =>
        store.runOperation(() => operation.apply(service, args));
      continue;
    }
    service[method] = function (actor, ...args) {
      return store.runOperation(() => {
        const state = store.getState();
        const token = state.apiTokens.find(
          (item) =>
            item.id === actor?.token?.id &&
            item.hash === actor?.token?.hash &&
            item.revokedAt === null,
        );
        assert(token, 401, "Invalid token");
        const currentActor = actorFromRecord(state, token);
        const write = /^(create|update|delete|revoke|change)/.test(method);
        const globalAdmin = [
          "createProject",
          "deleteProject",
          "createEnvironment",
          "updateEnvironment",
          "deleteEnvironment",
          "createToken",
          "revokeToken",
        ].includes(method);
        requireScope(
          currentActor,
          globalAdmin ? "admin" : write ? "write" : "read",
        );
        if (/^(create|update|delete)/.test(method)) {
          const inputIndex = method.startsWith("create") ? 0 : 1;
          args[inputIndex] = validateOperation(method, args[inputIndex]);
        }
        return operation.call(service, currentActor, ...args);
      });
    };
  }
  return service;
}
