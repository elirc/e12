import {
  DEFAULT_RESOURCE_LIMITS,
  ENVIRONMENT_TYPES,
  PERMISSIONS,
  SEED_TOKENS,
} from "../core/constants.js";
import { createId, hashToken } from "../core/hash.js";

function isoNow() {
  return new Date().toISOString();
}

export function buildSeedState() {
  const now = isoNow();
  const adminUserId = createId("usr");
  const demoProjectId = createId("prj");
  const devEnvironmentId = createId("env");
  const prodEnvironmentId = createId("env");
  const testEnvironmentId = createId("env");
  const preProdEnvironmentId = createId("env");
  const betaSegmentId = createId("seg");
  const checkoutFlagId = createId("flag");
  const killSwitchFlagId = createId("flag");
  const strategyProdRolloutId = createId("str");
  const strategyDevEnabledId = createId("str");
  const strategyKillSwitchId = createId("str");
  const controlVariantId = createId("var");
  const treatmentVariantId = createId("var");
  const adminTokenId = createId("tok");
  const clientTokenId = createId("tok");
  const frontendTokenId = createId("tok");

  return {
    meta: {
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    users: [
      {
        id: adminUserId,
        name: "Demo Admin",
        email: "admin@example.com",
        roles: ["instance_admin"],
        createdAt: now,
      },
    ],
    roles: Object.entries(PERMISSIONS).map(([name, scopes]) => ({
      id: createId("role"),
      name,
      scopes: [...scopes],
    })),
    permissions: Object.entries(PERMISSIONS).map(([role, scopes]) => ({
      id: createId("perm"),
      role,
      scopes: [...scopes],
    })),
    projects: [
      {
        id: demoProjectId,
        key: "checkout",
        name: "Checkout",
        description: "Demo project for learning the rollout model.",
        ownerUserId: adminUserId,
        createdAt: now,
        updatedAt: now,
      },
    ],
    projectMembers: [
      {
        id: createId("mem"),
        projectId: demoProjectId,
        userId: adminUserId,
        role: "project_owner",
        createdAt: now,
      },
    ],
    environments: [
      {
        id: devEnvironmentId,
        key: "development",
        name: "Development",
        type: ENVIRONMENT_TYPES[0],
        protectChanges: false,
        createdAt: now,
      },
      {
        id: testEnvironmentId,
        key: "test",
        name: "Test",
        type: ENVIRONMENT_TYPES[1],
        protectChanges: false,
        createdAt: now,
      },
      {
        id: preProdEnvironmentId,
        key: "pre-production",
        name: "Pre-Production",
        type: ENVIRONMENT_TYPES[2],
        protectChanges: true,
        createdAt: now,
      },
      {
        id: prodEnvironmentId,
        key: "production",
        name: "Production",
        type: ENVIRONMENT_TYPES[3],
        protectChanges: true,
        createdAt: now,
      },
    ],
    projectEnvironments: [
      {
        id: createId("pe"),
        projectId: demoProjectId,
        environmentId: devEnvironmentId,
        defaultStrategy: {
          type: "enabled_for_all",
          name: "Dev default",
          parameters: {},
          constraints: [],
        },
        createdAt: now,
      },
      {
        id: createId("pe"),
        projectId: demoProjectId,
        environmentId: prodEnvironmentId,
        defaultStrategy: {
          type: "disabled",
          name: "Prod default",
          parameters: {},
          constraints: [],
        },
        createdAt: now,
      },
    ],
    featureFlags: [
      {
        id: checkoutFlagId,
        projectId: demoProjectId,
        key: "checkout_redesign",
        name: "Checkout Redesign",
        type: "release",
        description: "Gradually roll out a new checkout UI.",
        stale: false,
        archived: false,
        impressionData: true,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: null,
      },
      {
        id: killSwitchFlagId,
        projectId: demoProjectId,
        key: "payments_kill_switch",
        name: "Payments Kill Switch",
        type: "kill_switch",
        description: "Emergency off switch for payments.",
        stale: false,
        archived: false,
        impressionData: true,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: null,
      },
    ],
    featureFlagEnvironments: [
      {
        id: createId("ffe"),
        flagId: checkoutFlagId,
        environmentId: devEnvironmentId,
        createdAt: now,
      },
      {
        id: createId("ffe"),
        flagId: checkoutFlagId,
        environmentId: prodEnvironmentId,
        createdAt: now,
      },
      {
        id: createId("ffe"),
        flagId: killSwitchFlagId,
        environmentId: devEnvironmentId,
        createdAt: now,
      },
      {
        id: createId("ffe"),
        flagId: killSwitchFlagId,
        environmentId: prodEnvironmentId,
        createdAt: now,
      },
    ],
    strategies: [
      {
        id: strategyDevEnabledId,
        flagId: checkoutFlagId,
        environmentId: devEnvironmentId,
        name: "Dev always on",
        type: "enabled_for_all",
        parameters: {},
        constraints: [],
        segmentIds: [],
        sortOrder: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: strategyProdRolloutId,
        flagId: checkoutFlagId,
        environmentId: prodEnvironmentId,
        name: "Beta gradual rollout",
        type: "gradual_rollout",
        parameters: {
          rollout: 25,
          stickiness: "userId",
          groupId: "checkout_redesign",
        },
        constraints: [],
        segmentIds: [betaSegmentId],
        sortOrder: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: strategyKillSwitchId,
        flagId: killSwitchFlagId,
        environmentId: prodEnvironmentId,
        name: "Emergency shutdown",
        type: "disabled",
        parameters: {},
        constraints: [],
        segmentIds: [],
        sortOrder: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
    strategyConstraints: [],
    segments: [
      {
        id: betaSegmentId,
        name: "Beta users",
        description: "Users in the beta cohort.",
        projectId: demoProjectId,
        constraints: [
          {
            field: "plan",
            operator: "in",
            values: ["pro", "enterprise"],
            inversion: false,
            caseSensitive: false,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
    segmentConstraints: [],
    variants: [
      {
        id: controlVariantId,
        strategyId: strategyProdRolloutId,
        name: "control",
        weight: 50,
        stickiness: "userId",
        payloadType: "json",
        payload: { theme: "classic" },
        createdAt: now,
      },
      {
        id: treatmentVariantId,
        strategyId: strategyProdRolloutId,
        name: "treatment",
        weight: 50,
        stickiness: "userId",
        payloadType: "json",
        payload: { theme: "bold" },
        createdAt: now,
      },
    ],
    apiTokens: [
      {
        id: adminTokenId,
        name: "Demo Admin PAT",
        type: "personal",
        hash: hashToken(SEED_TOKENS.admin),
        scopes: ["read", "write", "admin", "evaluate"],
        userId: adminUserId,
        projectIds: [],
        environmentIds: [],
        createdAt: now,
        revokedAt: null,
        lastUsedAt: null,
      },
      {
        id: clientTokenId,
        name: "Prod client token",
        type: "client",
        hash: hashToken(SEED_TOKENS.client),
        scopes: ["evaluate"],
        userId: null,
        projectIds: [demoProjectId],
        environmentIds: [prodEnvironmentId],
        createdAt: now,
        revokedAt: null,
        lastUsedAt: null,
      },
      {
        id: frontendTokenId,
        name: "Dev frontend token",
        type: "frontend",
        hash: hashToken(SEED_TOKENS.frontend),
        scopes: ["evaluate"],
        userId: null,
        projectIds: [demoProjectId],
        environmentIds: [devEnvironmentId],
        createdAt: now,
        revokedAt: null,
        lastUsedAt: null,
      },
    ],
    auditLogs: [],
    flagDependencies: [],
    metricsImpressions: [],
    sdkClients: [],
    resourceLimits: { ...DEFAULT_RESOURCE_LIMITS },
  };
}
