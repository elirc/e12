import { bucketValue } from "./hash.js";
import { CONSTRAINT_OPERATORS } from "./constants.js";

const scalar = (value) =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));
const identity = (value) =>
  (typeof value === "string" && value.length > 0) ||
  (typeof value === "number" && Number.isFinite(value));
const ownValue = (context, field) =>
  context && typeof context === "object" && Object.hasOwn(context, field)
    ? context[field]
    : undefined;

function coerceValue(value, caseSensitive) {
  if (typeof value !== "string") {
    return value;
  }
  return caseSensitive ? value : value.toLowerCase();
}

function normalizeValues(values, caseSensitive) {
  return values.map((value) => coerceValue(value, caseSensitive));
}

export function matchConstraint(constraint, context = {}) {
  if (
    !constraint ||
    typeof constraint !== "object" ||
    Array.isArray(constraint)
  )
    return false;
  const {
    field,
    operator,
    values = [],
    inversion = false,
    caseSensitive = false,
  } = constraint;
  if (
    typeof field !== "string" ||
    !field ||
    ["__proto__", "constructor", "prototype"].includes(field) ||
    !CONSTRAINT_OPERATORS.includes(operator) ||
    !Array.isArray(values) ||
    !values.length ||
    values.length > 100 ||
    !values.every(scalar) ||
    typeof inversion !== "boolean" ||
    typeof caseSensitive !== "boolean"
  )
    return false;
  const rawValue = ownValue(context, field);
  // Missing or invalid data must not become an enabled result through negation.
  if (!scalar(rawValue)) return false;
  if (!["in", "not_in"].includes(operator) && values.length !== 1) return false;
  if (
    ["starts_with", "ends_with", "contains"].includes(operator) &&
    (typeof rawValue !== "string" ||
      typeof values[0] !== "string" ||
      !values[0])
  )
    return false;
  if (
    ["greater_than", "less_than"].includes(operator) &&
    (typeof rawValue !== "number" || typeof values[0] !== "number")
  )
    return false;
  if (
    ["date_after", "date_before"].includes(operator) &&
    (typeof rawValue !== "string" ||
      typeof values[0] !== "string" ||
      !Number.isFinite(Date.parse(rawValue)) ||
      !Number.isFinite(Date.parse(values[0])))
  )
    return false;
  const candidate =
    typeof rawValue === "string"
      ? coerceValue(rawValue, caseSensitive)
      : rawValue;
  const targets = normalizeValues(values, caseSensitive);

  let matched = false;

  switch (operator) {
    case "equals":
      matched = candidate === targets[0];
      break;
    case "in":
      matched = targets.includes(candidate);
      break;
    case "not_in":
      matched = !targets.includes(candidate);
      break;
    case "starts_with":
      matched =
        typeof candidate === "string" && candidate.startsWith(targets[0] ?? "");
      break;
    case "ends_with":
      matched =
        typeof candidate === "string" && candidate.endsWith(targets[0] ?? "");
      break;
    case "contains":
      matched =
        typeof candidate === "string" && candidate.includes(targets[0] ?? "");
      break;
    case "greater_than":
      matched = Number(candidate) > Number(targets[0]);
      break;
    case "less_than":
      matched = Number(candidate) < Number(targets[0]);
      break;
    case "date_after":
      matched = Date.parse(String(candidate)) > Date.parse(String(targets[0]));
      break;
    case "date_before":
      matched = Date.parse(String(candidate)) < Date.parse(String(targets[0]));
      break;
    default:
      matched = false;
  }

  return inversion ? !matched : matched;
}

export function matchConstraints(constraints = [], context = {}) {
  if (!Array.isArray(constraints))
    return { matched: false, failures: ["Invalid constraints collection"] };
  const failures = [];

  for (const constraint of constraints) {
    const ok = matchConstraint(constraint, context);
    if (!ok) {
      failures.push(
        `${constraint?.field ?? "unknown field"} ${constraint?.operator ?? "unknown operator"} ${Array.isArray(constraint?.values) ? constraint.values.join(",") : "invalid values"}`,
      );
    }
  }

  return {
    matched: failures.length === 0,
    failures,
  };
}

function resolveStrategyConstraints(strategy, snapshot) {
  if (
    !Array.isArray(strategy.segmentIds ?? []) ||
    !Array.isArray(strategy.constraints ?? [])
  )
    return null;
  const constraints = [];
  for (const segmentId of strategy.segmentIds ?? []) {
    if (
      typeof segmentId !== "string" ||
      !Object.hasOwn(snapshot.segmentsById, segmentId)
    )
      return null;
    const segment = snapshot.segmentsById[segmentId];
    if (!Array.isArray(segment?.constraints)) return null;
    constraints.push(...segment.constraints);
  }
  return [...constraints, ...(strategy.constraints ?? [])];
}

function matchGradualRollout(strategy, context, flagKey) {
  const rollout = strategy.parameters?.rollout ?? 0;
  if (!Number.isInteger(rollout) || rollout < 0 || rollout > 100)
    return { matched: false, reason: "Invalid rollout percentage" };
  const stickinessField = strategy.parameters?.stickiness || "userId";
  const stickinessValue = ownValue(context, stickinessField);

  if (!identity(stickinessValue)) {
    return {
      matched: false,
      reason: `Missing stickiness field "${stickinessField}"`,
    };
  }

  const groupId = strategy.parameters?.groupId || flagKey;
  const bucket = bucketValue(`${groupId}:${stickinessValue}`);
  return {
    matched: bucket <= rollout,
    reason:
      bucket <= rollout
        ? "Within gradual rollout bucket"
        : `Bucket ${bucket} > ${rollout}`,
    bucket,
  };
}

function pickVariant(strategy, context, flagKey) {
  if (!Array.isArray(strategy.variants ?? [])) return null;
  const variants = [...(strategy.variants ?? [])];
  if (variants.length === 0) {
    return null;
  }

  const names = new Set();
  if (
    variants.some((variant) => {
      if (
        !variant ||
        typeof variant.name !== "string" ||
        !variant.name ||
        names.has(variant.name) ||
        !Number.isInteger(variant.weight) ||
        variant.weight < 0 ||
        variant.weight > 100
      )
        return true;
      names.add(variant.name);
      return false;
    })
  )
    return null;
  const totalWeight = variants.reduce(
    (sum, variant) => sum + variant.weight,
    0,
  );
  if (totalWeight !== 100) {
    return null;
  }

  const stickinessField =
    variants[0]?.stickiness || strategy.parameters?.stickiness || "userId";
  const stickinessValue =
    ownValue(context, stickinessField) ?? ownValue(context, "sessionId");
  if (!identity(stickinessValue)) return null;
  const bucket = bucketValue(
    `variant:${flagKey}:${stickinessValue}`,
    totalWeight,
  );

  let cursor = 0;
  for (const variant of variants) {
    cursor += Number(variant.weight ?? 0);
    if (bucket <= cursor) {
      return {
        name: variant.name,
        payloadType: variant.payloadType,
        payload: variant.payload,
      };
    }
  }

  return {
    name: variants[variants.length - 1].name,
    payloadType: variants[variants.length - 1].payloadType,
    payload: variants[variants.length - 1].payload,
  };
}

function evaluateStrategy(strategy, snapshot, context, flag) {
  const combinedConstraints = resolveStrategyConstraints(strategy, snapshot);
  if (combinedConstraints === null)
    return {
      matched: false,
      reason: "Missing segment or invalid constraints",
      strategyId: strategy.id,
      strategyName: strategy.name,
    };
  const constraintResult = matchConstraints(combinedConstraints, context);

  if (!constraintResult.matched) {
    return {
      matched: false,
      reason: `Constraint mismatch: ${constraintResult.failures.join("; ")}`,
      strategyId: strategy.id,
      strategyName: strategy.name,
    };
  }

  if (strategy.type === "disabled") {
    return {
      matched: false,
      reason: "Strategy explicitly disables the flag",
      strategyId: strategy.id,
      strategyName: strategy.name,
    };
  }

  if (strategy.type === "enabled_for_all") {
    return {
      matched: true,
      reason: "Enabled for all",
      strategyId: strategy.id,
      strategyName: strategy.name,
    };
  }

  if (strategy.type === "gradual_rollout") {
    const rolloutResult = matchGradualRollout(strategy, context, flag.key);
    return {
      ...rolloutResult,
      strategyId: strategy.id,
      strategyName: strategy.name,
    };
  }

  return {
    matched: false,
    reason: `Unknown custom strategy "${strategy.type}"`,
    strategyId: strategy.id,
    strategyName: strategy.name,
  };
}

export function evaluateFlag(
  flagRecord,
  snapshot,
  context,
  memo = new Map(),
  stack = [],
) {
  const memoKey = flagRecord.flag.id;
  if (memo.has(memoKey)) {
    return memo.get(memoKey);
  }

  if (stack.includes(flagRecord.flag.id)) {
    const cycleResult = {
      flagKey: flagRecord.flag.key,
      enabled: false,
      variant: null,
      matchedStrategy: null,
      reasons: ["Dependency cycle detected during evaluation"],
    };
    memo.set(memoKey, cycleResult);
    return cycleResult;
  }

  const reasons = [];
  const nextStack = [...stack, flagRecord.flag.id];

  if (flagRecord.flag.archived) {
    const archivedResult = {
      flagKey: flagRecord.flag.key,
      enabled: false,
      variant: null,
      matchedStrategy: null,
      reasons: ["Flag is archived"],
    };
    memo.set(memoKey, archivedResult);
    return archivedResult;
  }

  for (const dependency of flagRecord.dependencies) {
    const parentFlag = Object.hasOwn(
      snapshot.flagsById,
      dependency.parentFlagId,
    )
      ? snapshot.flagsById[dependency.parentFlagId]
      : null;
    if (!parentFlag) {
      reasons.push(`Dependency missing: ${dependency.parentFlagId}`);
      memo.set(memoKey, {
        flagKey: flagRecord.flag.key,
        enabled: false,
        variant: null,
        matchedStrategy: null,
        reasons,
      });
      return memo.get(memoKey);
    }
    const parentResult = evaluateFlag(
      parentFlag,
      snapshot,
      context,
      memo,
      nextStack,
    );
    if (!parentResult.enabled) {
      reasons.push(`Dependency ${parentFlag.flag.key} is disabled`);
      memo.set(memoKey, {
        flagKey: flagRecord.flag.key,
        enabled: false,
        variant: null,
        matchedStrategy: null,
        reasons,
      });
      return memo.get(memoKey);
    }
  }

  const strategies =
    flagRecord.strategies.length > 0
      ? flagRecord.strategies
      : [snapshot.defaultStrategy];
  const matches = [];

  for (const strategy of strategies) {
    const result = evaluateStrategy(
      strategy,
      snapshot,
      context,
      flagRecord.flag,
    );
    if (result.matched) {
      matches.push(result);
    } else {
      reasons.push(result.reason);
    }
  }

  if (matches.length === 0) {
    const disabledResult = {
      flagKey: flagRecord.flag.key,
      enabled: false,
      variant: null,
      matchedStrategy: null,
      reasons,
    };
    memo.set(memoKey, disabledResult);
    return disabledResult;
  }

  const selectedMatch = matches[0];
  const selectedStrategy =
    strategies.find((strategy) => strategy.id === selectedMatch.strategyId) ??
    strategies[0];
  const variant = pickVariant(selectedStrategy, context, flagRecord.flag.key);
  const result = {
    flagKey: flagRecord.flag.key,
    enabled: true,
    variant,
    matchedStrategy: {
      id: selectedMatch.strategyId,
      name: selectedMatch.strategyName,
      type: selectedStrategy.type,
    },
    reasons:
      matches.length > 1
        ? [
            `${matches.length} strategies matched; first match won by sort order`,
          ]
        : [selectedMatch.reason],
  };

  memo.set(memoKey, result);
  return result;
}

export function evaluateSnapshot(snapshot, context = {}) {
  const memo = new Map();
  return snapshot.flags.map((flagRecord) =>
    evaluateFlag(flagRecord, snapshot, context, memo),
  );
}
