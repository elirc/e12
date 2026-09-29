export const ENVIRONMENT_TYPES = [
  "development",
  "test",
  "pre-production",
  "production",
];

export const FLAG_TYPES = [
  "release",
  "experiment",
  "operational",
  "kill_switch",
  "permission",
];

export const STRATEGY_TYPES = [
  "disabled",
  "enabled_for_all",
  "gradual_rollout",
  "custom",
];

export const TOKEN_TYPES = ["personal", "client", "frontend"];

export const TOKEN_SCOPES = ["read", "write", "admin", "evaluate"];

export const INSTANCE_ROLES = [
  "instance_admin",
  "project_owner",
  "project_member",
  "viewer",
];

export const CONSTRAINT_OPERATORS = [
  "equals",
  "in",
  "not_in",
  "starts_with",
  "ends_with",
  "contains",
  "greater_than",
  "less_than",
  "date_after",
  "date_before",
];

export const DEFAULT_RESOURCE_LIMITS = {
  maxProjects: 25,
  maxEnvironments: 8,
  maxFlagsPerProject: 200,
  maxStrategiesPerFlagEnvironment: 10,
  maxConstraintsPerStrategy: 20,
  maxSegments: 100,
  maxTokens: 200,
  staleFlagAgeDays: 90,
  evaluationRequestsPerMinute: 5000,
  tokenCreationsPerHour: 50,
};

export const SEED_TOKENS = {
  admin: "demo-instance-admin-token",
  client: "demo-production-client-token",
  frontend: "demo-development-frontend-token",
};

export const PERMISSIONS = {
  instance_admin: ["read", "write", "admin", "evaluate"],
  viewer: ["read"],
  project_owner: ["read", "write", "evaluate"],
  project_member: ["read", "write", "evaluate"],
};
