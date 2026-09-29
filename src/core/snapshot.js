import { createId } from "./hash.js";

function mapById(items) {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

export function compileSnapshot(state, projectId, environmentId) {
  const project = state.projects.find((item) => item.id === projectId);
  const environment = state.environments.find(
    (item) => item.id === environmentId,
  );
  const projectEnvironment = state.projectEnvironments.find(
    (item) =>
      item.projectId === projectId && item.environmentId === environmentId,
  );

  if (!project || !environment || !projectEnvironment) {
    return null;
  }

  const segments = state.segments.filter(
    (segment) => segment.projectId === null || segment.projectId === projectId,
  );
  const strategiesByFlag = new Map();

  const scopedStrategies = state.strategies
    .filter((strategy) => strategy.environmentId === environmentId)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((strategy) => ({
      ...strategy,
      variants: state.variants.filter(
        (variant) => variant.strategyId === strategy.id,
      ),
    }));

  for (const strategy of scopedStrategies) {
    const collection = strategiesByFlag.get(strategy.flagId) ?? [];
    collection.push(strategy);
    strategiesByFlag.set(strategy.flagId, collection);
  }

  const dependenciesByChild = new Map();
  for (const dependency of state.flagDependencies.filter(
    (item) => item.projectId === projectId,
  )) {
    const collection = dependenciesByChild.get(dependency.childFlagId) ?? [];
    collection.push(dependency);
    dependenciesByChild.set(dependency.childFlagId, collection);
  }

  const flags = state.featureFlags
    .filter((flag) => flag.projectId === projectId)
    .filter((flag) =>
      state.featureFlagEnvironments.some(
        (mapping) =>
          mapping.flagId === flag.id && mapping.environmentId === environmentId,
      ),
    )
    .map((flag) => ({
      id: createId("snap"),
      flag,
      strategies: strategiesByFlag.get(flag.id) ?? [],
      dependencies: dependenciesByChild.get(flag.id) ?? [],
    }));

  const snapshot = {
    id: `${project.key}:${environment.key}:${state.meta.version}`,
    etag: `W/"${project.key}-${environment.key}-${state.meta.version}"`,
    version: state.meta.version,
    generatedAt: state.meta.updatedAt,
    project,
    environment,
    defaultStrategy: {
      id: `${projectEnvironment.id}:default`,
      flagId: null,
      environmentId,
      name: projectEnvironment.defaultStrategy?.name || "Default",
      type: projectEnvironment.defaultStrategy?.type || "disabled",
      parameters: projectEnvironment.defaultStrategy?.parameters || {},
      constraints: projectEnvironment.defaultStrategy?.constraints || [],
      segmentIds: [],
      sortOrder: 999,
      variants: [],
    },
    segments,
    segmentsById: mapById(segments),
    flags,
  };

  snapshot.flagsById = Object.fromEntries(
    snapshot.flags.map((flagRecord) => [flagRecord.flag.id, flagRecord]),
  );
  return snapshot;
}
