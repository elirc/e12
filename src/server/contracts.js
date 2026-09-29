import {
  CONSTRAINT_OPERATORS,
  ENVIRONMENT_TYPES,
  FLAG_TYPES,
  TOKEN_SCOPES,
  TOKEN_TYPES,
} from "../core/constants.js";

function reject(field, message) {
  throw Object.assign(new Error(`${field}: ${message}`), { status: 422 });
}
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text =
  (max, { empty = false, trim = true } = {}) =>
  (value, field) => {
    if (
      typeof value !== "string" ||
      !value.isWellFormed() ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
    )
      reject(field, "must be valid text without control characters");
    const result = trim ? value.trim() : value;
    if ((!empty && !result) || result.length > max)
      reject(field, `must contain ${empty ? 0 : 1}..${max} characters`);
    return result;
  };
const name = (value, field) => {
  const result = text(100)(value, field);
  if (/[\r\n\t]/.test(result)) reject(field, "must be a single line");
  return result;
};
const description = text(5000, { empty: true, trim: false });
const id = (value, field) => {
  const result = text(128)(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result))
    reject(field, "invalid identifier");
  return result;
};
const key = (value, field) => {
  const result = text(80)(value, field);
  if (!/^[a-z][a-z0-9_-]*$/.test(result))
    reject(
      field,
      "use a lowercase letter followed by lowercase letters, numbers, underscores or hyphens",
    );
  return result;
};
const boolean = (value, field) => {
  if (typeof value !== "boolean") reject(field, "must be a boolean");
  return value;
};
const integer = (max) => (value, field) => {
  if (!Number.isInteger(value) || value < 0 || value > max)
    reject(field, `must be an integer from 0 to ${max}`);
  return value;
};
const choice = (values) => (value, field) => {
  if (!values.includes(value)) reject(field, "unsupported value");
  return value;
};
const nullable = (validator) => (value, field) =>
  value === null ? null : validator(value, field);
const array =
  (validator, max, { min = 0, unique = false } = {}) =>
  (value, field) => {
    if (!Array.isArray(value) || value.length < min || value.length > max)
      reject(field, `must be an array with ${min}..${max} items`);
    const result = value.map((item, index) =>
      validator(item, `${field}[${index}]`),
    );
    if (unique && new Set(result).size !== result.length)
      reject(field, "duplicate values are not allowed");
    return result;
  };
const ids = (max = 100, min = 0) => array(id, max, { min, unique: true });
const confirmation = (value, field) =>
  Array.isArray(value)
    ? array(text(150), 8, { unique: true })(value, field)
    : text(150)(value, field);

function object(value, fields, required = [], field = "body") {
  if (!plain(value)) reject(field, "must be a plain object");
  for (const key of Object.keys(value))
    if (!Object.hasOwn(fields, key)) reject(`${field}.${key}`, "unknown field");
  for (const key of required)
    if (!Object.hasOwn(value, key)) reject(`${field}.${key}`, "is required");
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      fields[key](item, `${field}.${key}`),
    ]),
  );
}

function jsonValue(value, field, depth = 0) {
  if (depth > 6) reject(field, "JSON nesting exceeds six levels");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject(field, "must be finite");
    return value;
  }
  if (typeof value === "string")
    return text(16000, { empty: true, trim: false })(value, field);
  if (Array.isArray(value)) {
    if (value.length > 100)
      reject(field, "JSON arrays may contain at most 100 items");
    return value.map((item) => jsonValue(item, field, depth + 1));
  }
  if (!plain(value) || Object.keys(value).length > 100)
    reject(field, "unsupported JSON value");
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (
        key.length > 128 ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        reject(field, "unsupported JSON key");
      return [key, jsonValue(item, field, depth + 1)];
    }),
  );
}

const scalar = (value, field) => {
  if (typeof value === "string")
    return text(1000, { empty: true, trim: false })(value, field);
  if (
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  reject(field, "constraint values must be text, booleans or finite numbers");
};
const contextField = (value, field) => {
  const result = id(value, field);
  if (["__proto__", "constructor", "prototype"].includes(result))
    reject(field, "reserved context field");
  return result;
};
function constraint(value, field) {
  const result = object(
    value,
    {
      field: contextField,
      operator: choice(CONSTRAINT_OPERATORS),
      values: array(scalar, 100, { min: 1 }),
      inversion: boolean,
      caseSensitive: boolean,
    },
    ["field", "operator", "values"],
    field,
  );
  if (!["in", "not_in"].includes(result.operator) && result.values.length !== 1)
    reject(field, "this operator needs exactly one comparison value");
  if (
    ["greater_than", "less_than"].includes(result.operator) &&
    typeof result.values[0] !== "number"
  )
    reject(field, "numeric comparison requires a number");
  if (
    ["starts_with", "ends_with", "contains"].includes(result.operator) &&
    (typeof result.values[0] !== "string" || !result.values[0])
  )
    reject(field, "string comparison requires nonempty text");
  if (
    ["date_after", "date_before"].includes(result.operator) &&
    (typeof result.values[0] !== "string" ||
      !Number.isFinite(Date.parse(result.values[0])))
  )
    reject(field, "date comparison requires a valid date string");
  return result;
}
const constraints = array(constraint, 20);
const parameters = (value, field) =>
  object(
    value,
    { rollout: integer(100), stickiness: contextField, groupId: text(100) },
    [],
    field,
  );
const strategyType = choice(["enabled_for_all", "disabled", "gradual_rollout"]);

export function validateStrategySettings(value, field = "strategy") {
  strategyType(value.type, `${field}.type`);
  const params = parameters(value.parameters ?? {}, `${field}.parameters`);
  if (value.type === "gradual_rollout") {
    if (!Object.hasOwn(params, "rollout"))
      reject(field, "gradual rollout requires a rollout percentage");
  } else if (Object.keys(params).length)
    reject(field, "only gradual rollout accepts parameters");
  return value;
}
function defaultStrategy(value, field) {
  const result = object(
    value,
    { type: strategyType, name, parameters, constraints },
    ["type"],
    field,
  );
  return validateStrategySettings(result, field);
}
const defaultStrategies = (value, field) => {
  if (!plain(value) || Object.keys(value).length > 8)
    reject(
      field,
      "must map at most eight environment IDs to default strategies",
    );
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      id(key, field),
      defaultStrategy(item, `${field}.${key}`),
    ]),
  );
};
const variantFields = {
  name,
  weight: integer(100),
  stickiness: contextField,
  payloadType: choice(["string", "json"]),
  payload: jsonValue,
};
export function validateVariant(value, field = "variant", partial = false) {
  const result = object(
    value,
    variantFields,
    partial ? [] : ["name", "weight"],
    field,
  );
  if (
    Object.hasOwn(result, "payload") &&
    (result.payloadType ?? "string") === "string" &&
    typeof result.payload !== "string"
  )
    reject(
      field,
      "string payloads must contain text; choose json for other JSON values",
    );
  if (
    Object.hasOwn(result, "payload") &&
    Buffer.byteLength(JSON.stringify(result.payload), "utf8") > 16000
  )
    reject(field, "payload exceeds 16 KiB");
  return result;
}
const variants = (value, field) => {
  const result = array((item, label) => validateVariant(item, label), 20)(
    value,
    field,
  );
  if (
    result.length &&
    result.reduce((sum, item) => sum + item.weight, 0) !== 100
  )
    reject(field, "variant weights must sum to 100");
  if (new Set(result.map((item) => item.name)).size !== result.length)
    reject(field, "variant names must be unique");
  const stickiness = new Set(
    result.map((item) => item.stickiness).filter((item) => item !== undefined),
  );
  if (stickiness.size > 1)
    reject(
      field,
      "variants in one strategy must use the same stickiness field",
    );
  return result;
};

const common = { confirmation };
const project = {
  name,
  description,
  ownerUserId: id,
  environmentIds: ids(8, 1),
  defaultStrategies,
  ...common,
};
const environment = {
  name,
  type: choice(ENVIRONMENT_TYPES),
  protectChanges: boolean,
  ...common,
};
const flag = {
  name,
  key,
  type: choice(FLAG_TYPES),
  description,
  stale: boolean,
  archived: boolean,
  impressionData: boolean,
  ...common,
};
const { stale: _stale, archived: _archived, ...newFlag } = flag;
const segment = { name, description, constraints, ...common };
const strategy = {
  name,
  type: strategyType,
  parameters,
  constraints,
  segmentIds: ids(20),
  sortOrder: integer(10000),
  variants,
  ...common,
};
const token = {
  name,
  type: choice(TOKEN_TYPES),
  scopes: array(choice(TOKEN_SCOPES), 4, { min: 1, unique: true }),
  userId: nullable(id),
  projectIds: ids(1),
  environmentIds: ids(1),
  expiresAt: nullable(text(50)),
};
const schemas = {
  createProject: [{ ...project, key }, ["name", "key", "environmentIds"]],
  updateProject: [project],
  createEnvironment: [{ ...environment, key }, ["name", "key", "type"]],
  updateEnvironment: [environment],
  createFlag: [
    { ...newFlag, projectId: id, environmentIds: ids(8, 1) },
    ["name", "key", "type", "projectId"],
  ],
  updateFlag: [flag],
  createSegment: [{ ...segment, projectId: nullable(id) }, ["name"]],
  updateSegment: [segment],
  createStrategy: [
    { ...strategy, flagId: id, environmentId: id },
    ["type", "flagId", "environmentId"],
  ],
  updateStrategy: [strategy],
  createVariant: [
    { ...variantFields, strategyId: id, ...common },
    ["strategyId", "name", "weight"],
  ],
  updateVariant: [{ ...variantFields, ...common }],
  createDependency: [
    { parentFlagId: id, childFlagId: id, ...common },
    ["parentFlagId", "childFlagId"],
  ],
  createToken: [token, ["name", "type", "scopes"]],
};

export function validateOperation(method, input) {
  if (method.startsWith("delete")) return object(input ?? {}, common);
  const schema = schemas[method];
  if (!schema) return input;
  const result = object(input, schema[0], schema[1] ?? []);
  if (
    method.startsWith("update") &&
    !Object.keys(result).some((key) => key !== "confirmation")
  )
    reject("body", "provide at least one editable field");
  if (method === "createStrategy") validateStrategySettings(result);
  if (method === "createVariant") {
    const { strategyId, confirmation, ...variant } = result;
    validateVariant(variant);
  }
  return result;
}

export function validateEvaluationContext(context = {}) {
  if (!plain(context)) reject("context", "must be a plain object");
  return jsonValue(context, "context");
}

export function validateMetricsInput(input) {
  const contextHash = (value, field) => {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
      reject(field, "must be a lowercase SHA-256 hex digest");
    return value;
  };
  const impression = (value, field) =>
    object(
      value,
      {
        projectId: id,
        environmentId: id,
        flagId: id,
        enabled: boolean,
        variantName: nullable(name),
        contextHash: nullable(contextHash),
      },
      ["flagId", "enabled"],
      field,
    );
  return object(input, { impressions: array(impression, 100, { min: 1 }) }, [
    "impressions",
  ]);
}
