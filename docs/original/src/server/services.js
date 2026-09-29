import crypto from "node:crypto";

import {
  DEFAULT_RESOURCE_LIMITS,
  FLAG_TYPES,
  INSTANCE_ROLES,
  TOKEN_SCOPES,
  TOKEN_TYPES,
} from "../core/constants.js";
import { evaluateSnapshot } from "../core/evaluation.js";
import { createId, hashToken } from "../core/hash.js";

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
  const token = state.apiTokens.find(
    (item) => item.hash === hashToken(rawToken) && item.revokedAt === null,
  );
  if (!token) {
    throw createError(401, "Invalid token");
  }
  const user = token.userId ? state.users.find((item) => item.id === token.userId) : null;
  return { token, user };
}

function requireScope(actor, scope) {
  assert(actor.token.scopes.includes(scope), 403, `Token is missing "${scope}" scope`);
}

function requireAdminRole(actor) {
  if (!actor.user) {
    throw createError(403, "This route requires a personal access token");
  }
  const roles = actor.user.roles ?? [];
  assert(
    roles.some((role) => INSTANCE_ROLES.includes(role)),
    403,
    "User does not have an admin role",
  );
}

function canReadProject(state, actor, projectId) {
  if (!actor.user) {
    return false;
  }
  if (actor.user.roles.includes("instance_admin") || actor.user.roles.includes("viewer")) {
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
  const membership = getProjectMembership(state, actor.user.id, projectId);
  return membership && ["project_owner", "project_member"].includes(membership.role);
}

function requireProjectRead(state, actor, projectId) {
  assert(canReadProject(state, actor, projectId), 403, "Project read access denied");
}

function requireProjectWrite(state, actor, projectId) {
  assert(canWriteProject(state, actor, projectId), 403, "Project write access denied");
}

function appendAudit(state, { actor, action, resourceType, resourceId, before, after, metadata }) {
  state.auditLogs.unshift({
    id: createId("audit"),
    actorTokenId: actor?.token?.id ?? null,
    actorUserId: actor?.user?.id ?? null,
    action,
    resourceType,
    resourceId,
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
  assert(environmentIds.length > 0, 400, "Each project must keep at least one active environment");
  for (const environmentId of environmentIds) {
    assert(getEnvironment(state, environmentId), 400, `Unknown environment "${environmentId}"`);
  }
}

function assertProtectedEnvironmentConfirmation(state, environmentId, confirmation) {
  const environment = getEnvironment(state, environmentId);
  if (environment?.protectChanges) {
    assert(
      confirmation === `CONFIRM:${environment.key}`,
      409,
      `Protected environment "${environment.key}" requires confirmation`,
    );
  }
}

function assertVariantWeights(variants = []) {
  if (variants.length === 0) {
    return;
  }
  const total = variants.reduce((sum, variant) => sum + Number(variant.weight ?? 0), 0);
  assert(total === 100, 400, "Variant weights must sum to 100");
}

function assertSiblingVariantWeights(state, strategyId, candidate, ignoreVariantId = null) {
  const siblings = state.variants.filter(
    (variant) => variant.strategyId === strategyId && variant.id !== ignoreVariantId,
  );
  assertVariantWeights([...siblings, candidate]);
}

function detectDependencyCycle(state, projectId, parentFlagId, childFlagId) {
  const adjacency = new Map();
  for (const dependency of state.flagDependencies.filter((item) => item.projectId === projectId)) {
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
      variants: state.variants.filter((variant) => variant.strategyId === strategy.id),
      environment: getEnvironment(state, strategy.environmentId),
    }));
  const dependencies = state.flagDependencies.filter((dependency) => dependency.childFlagId === flag.id);
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
    .filter((flag) => query.archived === undefined || flag.archived === query.archived)
    .map((flag) => serializeFlag(state, flag));
}

function issuePlaintextToken() {
  return crypto.randomBytes(18).toString("hex");
}

function readTokenFromHeaders(headers) {
  const authorization = headers.authorization || "";
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
}

export function createPlatformService(store) {
  return {
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
          environments: state.projectEnvironments
            .filter((mapping) => mapping.projectId === project.id)
            .map((mapping) => ({
              ...getEnvironment(state, mapping.environmentId),
              defaultStrategy: mapping.defaultStrategy,
            })),
        }));
    },

    createProject(actor, input) {
      requireAdminRole(actor);
      const state = store.getState();
      const limits = state.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
      assert(state.projects.length < limits.maxProjects, 409, "Project limit reached");
      assert(input.name && input.key, 400, "Project name and key are required");
      assert(
        !state.projects.some((project) => project.key === input.key),
        409,
        `Project key "${input.key}" already exists`,
      );
      const ownerUserId = input.ownerUserId || actor.user.id;
      assert(state.users.some((user) => user.id === ownerUserId), 400, "Unknown owner user");
      assertProjectEnvironmentSelection(state, input.environmentIds ?? []);

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
        if (input.description !== undefined) project.description = input.description;
        if (input.ownerUserId) project.ownerUserId = input.ownerUserId;

        if (input.environmentIds) {
          assertProjectEnvironmentSelection(draft, input.environmentIds);
          draft.projectEnvironments = draft.projectEnvironments.filter(
            (item) => item.projectId !== projectId || input.environmentIds.includes(item.environmentId),
          );
          for (const environmentId of input.environmentIds) {
            const existing = draft.projectEnvironments.find(
              (item) => item.projectId === projectId && item.environmentId === environmentId,
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
          for (const [environmentId, defaultStrategy] of Object.entries(input.defaultStrategies)) {
            assertProtectedEnvironmentConfirmation(draft, environmentId, input.confirmation);
            const mapping = draft.projectEnvironments.find(
              (item) => item.projectId === projectId && item.environmentId === environmentId,
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
      return store.getState().environments;
    },

    listUsers(actor) {
      requireAdminRole(actor);
      return store.getState().users;
    },

    createEnvironment(actor, input) {
      requireAdminRole(actor);
      const state = store.getState();
      const limits = state.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
      assert(state.environments.length < limits.maxEnvironments, 409, "Environment limit reached");
      assert(input.name && input.key && input.type, 400, "Environment name, key, and type are required");
      assert(
        !state.environments.some((environment) => environment.key === input.key),
        409,
        `Environment key "${input.key}" already exists`,
      );

      return store.mutate((draft) => {
        const environment = {
          id: createId("env"),
          key: input.key,
          name: input.name,
          type: input.type,
          protectChanges: Boolean(input.protectChanges ?? input.type === "production"),
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

    listFlags(actor, query = {}) {
      requireAdminRole(actor);
      const state = store.getState();
      if (query.projectId) {
        requireProjectRead(state, actor, query.projectId);
      }
      return filterFlags(state, query);
    },

    createFlag(actor, input) {
      requireAdminRole(actor);
      const state = store.getState();
      assert(input.projectId && input.key && input.name && input.type, 400, "Missing required flag fields");
      assert(FLAG_TYPES.includes(input.type), 400, "Invalid flag type");
      requireProjectWrite(state, actor, input.projectId);
      assertUniqueFlagKey(state, input.key);

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

      return store.mutate((draft) => {
        const target = getFlag(draft, flagId);
        const before = structuredClone(target);
        if (input.key && input.key !== target.key) {
          assertUniqueFlagKey(draft, input.key, flagId);
          target.key = input.key;
        }
        if (input.name) target.name = input.name;
        if (input.description !== undefined) target.description = input.description;
        if (input.type) target.type = input.type;
        if (input.stale !== undefined) target.stale = Boolean(input.stale);
        if (input.archived !== undefined) target.archived = Boolean(input.archived);
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

    changeFlagLifecycle(actor, flagId, action) {
      const updates = {
        stale: { stale: true },
        archive: { archived: true },
        unarchive: { archived: false },
      };
      assert(updates[action], 400, "Unknown lifecycle action");
      return this.updateFlag(actor, flagId, updates[action]);
    },

    createSegment(actor, input) {
      requireAdminRole(actor);
      const state = store.getState();
      if (input.projectId) {
        requireProjectWrite(state, actor, input.projectId);
      }
      const limits = state.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
      assert(state.segments.length < limits.maxSegments, 409, "Segment limit reached");
      assert(input.name, 400, "Segment name is required");

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
      }

      return store.mutate((draft) => {
        const target = draft.segments.find((item) => item.id === segmentId);
        const before = structuredClone(target);
        if (input.name) target.name = input.name;
        if (input.description !== undefined) target.description = input.description;
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
      assertProtectedEnvironmentConfirmation(state, input.environmentId, input.confirmation);
      assertVariantWeights(input.variants);

      const envMapping = state.featureFlagEnvironments.find(
        (item) => item.flagId === input.flagId && item.environmentId === input.environmentId,
      );
      assert(envMapping, 400, "Flag is not enabled in that environment");
      const currentStrategies = state.strategies.filter(
        (strategy) =>
          strategy.flagId === input.flagId && strategy.environmentId === input.environmentId,
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
            stickiness: variantInput.stickiness || input.parameters?.stickiness || "userId",
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
            variants: draft.variants.filter((variant) => variant.strategyId === strategy.id),
          },
        });
        return {
          ...strategy,
          variants: draft.variants.filter((variant) => variant.strategyId === strategy.id),
        };
      });
    },

    updateStrategy(actor, strategyId, input) {
      requireAdminRole(actor);
      const state = store.getState();
      const strategy = state.strategies.find((item) => item.id === strategyId);
      assert(strategy, 404, "Strategy not found");
      const flag = getFlag(state, strategy.flagId);
      requireProjectWrite(state, actor, flag.projectId);
      assertProtectedEnvironmentConfirmation(state, strategy.environmentId, input.confirmation);
      if (input.variants) {
        assertVariantWeights(input.variants);
      }

      return store.mutate((draft) => {
        const target = draft.strategies.find((item) => item.id === strategyId);
        const before = {
          ...structuredClone(target),
          variants: draft.variants.filter((variant) => variant.strategyId === strategyId),
        };
        if (input.name) target.name = input.name;
        if (input.type) target.type = input.type;
        if (input.parameters) target.parameters = input.parameters;
        if (input.constraints) target.constraints = input.constraints;
        if (input.segmentIds) target.segmentIds = input.segmentIds;
        if (input.sortOrder !== undefined) target.sortOrder = input.sortOrder;
        target.updatedAt = nowIso();
        if (input.variants) {
          draft.variants = draft.variants.filter((variant) => variant.strategyId !== strategyId);
          for (const variantInput of input.variants) {
            draft.variants.push({
              id: createId("var"),
              strategyId,
              name: variantInput.name,
              weight: variantInput.weight,
              stickiness: variantInput.stickiness || target.parameters?.stickiness || "userId",
              payloadType: variantInput.payloadType || "string",
              payload: variantInput.payload ?? "",
              createdAt: nowIso(),
            });
          }
        }
        const after = {
          ...target,
          variants: draft.variants.filter((variant) => variant.strategyId === strategyId),
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
      const strategy = state.strategies.find((item) => item.id === input.strategyId);
      assert(strategy, 404, "Strategy not found");
      const flag = getFlag(state, strategy.flagId);
      requireProjectWrite(state, actor, flag.projectId);
      assertProtectedEnvironmentConfirmation(state, strategy.environmentId, input.confirmation);
      assertSiblingVariantWeights(state, input.strategyId, input);

      return store.mutate((draft) => {
        const variant = {
          id: createId("var"),
          strategyId: input.strategyId,
          name: input.name,
          weight: input.weight,
          stickiness: input.stickiness || strategy.parameters?.stickiness || "userId",
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
      const strategy = state.strategies.find((item) => item.id === variant.strategyId);
      const flag = getFlag(state, strategy.flagId);
      requireProjectWrite(state, actor, flag.projectId);
      assertProtectedEnvironmentConfirmation(state, strategy.environmentId, input.confirmation);
      assertSiblingVariantWeights(state, strategy.id, { ...variant, ...input }, variantId);

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
      assert(parentFlag.projectId === childFlag.projectId, 400, "Dependencies must stay inside one project");
      requireProjectWrite(state, actor, parentFlag.projectId);
      assert(
        !detectDependencyCycle(state, parentFlag.projectId, input.parentFlagId, input.childFlagId),
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
      return state.apiTokens.map((token) => ({
        ...token,
        hash: undefined,
      }));
    },

    createToken(actor, input) {
      requireAdminRole(actor);
      const state = store.getState();
      const limits = state.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
      assert(
        store.useRateLimit(`token-create:${actor.user.id}`, limits.tokenCreationsPerHour, 60 * 60 * 1000),
        429,
        "Token creation rate limit exceeded",
      );
      assert(TOKEN_TYPES.includes(input.type), 400, "Invalid token type");
      for (const scope of input.scopes ?? []) {
        assert(TOKEN_SCOPES.includes(scope), 400, `Unknown scope "${scope}"`);
      }
      if (input.type === "personal") {
        assert(input.userId, 400, "Personal tokens require a user");
      }

      const plaintext = issuePlaintextToken();
      return store.mutate((draft) => {
        const token = {
          id: createId("tok"),
          name: input.name,
          type: input.type,
          hash: hashToken(plaintext),
          scopes: input.scopes ?? ["read"],
          userId: input.userId ?? null,
          projectIds: input.projectIds ?? [],
          environmentIds: input.environmentIds ?? [],
          createdAt: nowIso(),
          revokedAt: null,
          lastUsedAt: null,
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
      requireAdminRole(actor);
      return store.mutate((draft) => {
        const token = draft.apiTokens.find((item) => item.id === tokenId);
        assert(token, 404, "Token not found");
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
      return store.getState().auditLogs.slice(0, 100);
    },

    listSegments(actor) {
      requireAdminRole(actor);
      const state = store.getState();
      return state.segments.filter(
        (segment) => segment.projectId === null || canReadProject(state, actor, segment.projectId),
      );
    },

    getDashboard(actor, projectId, environmentId) {
      requireAdminRole(actor);
      const state = store.getState();
      requireProjectRead(state, actor, projectId);

      const flags = state.featureFlags.filter((flag) => flag.projectId === projectId);
      const project = getProject(state, projectId);
      const environment = getEnvironment(state, environmentId);
      const recentAudit = state.auditLogs.slice(0, 10);
      const impressions = state.metricsImpressions.filter(
        (item) => item.projectId === projectId && item.environmentId === environmentId,
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
        results: evaluateSnapshot(snapshot, input.context ?? {}),
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

      const ifNoneMatch = headers["if-none-match"];
      if (ifNoneMatch && ifNoneMatch === snapshot.etag) {
        return { notModified: true, etag: snapshot.etag };
      }

      const results = evaluateSnapshot(snapshot, body.context ?? {});
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
      const actor = getActorFromToken(store.getState(), tokenValue);
      requireScope(actor, "evaluate");
      return store.mutate((draft) => {
        for (const impression of input.impressions ?? []) {
          draft.metricsImpressions.push({
            id: createId("imp"),
            projectId: impression.projectId ?? actor.token.projectIds[0],
            environmentId: impression.environmentId ?? actor.token.environmentIds[0],
            flagId: impression.flagId,
            enabled: Boolean(impression.enabled),
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
      const rows = state.metricsImpressions.filter(
        (item) => item.projectId === query.projectId && item.environmentId === query.environmentId,
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
}
