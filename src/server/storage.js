import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { compileSnapshot } from "../core/snapshot.js";

export const MAX_STATE_BYTES = 16 * 1024 * 1024;
const DEFAULT_DATA_FILE = fileURLToPath(
  new URL("../../data/state.json", import.meta.url),
);
const COLLECTIONS = [
  "users",
  "roles",
  "permissions",
  "projects",
  "projectMembers",
  "environments",
  "projectEnvironments",
  "featureFlags",
  "featureFlagEnvironments",
  "strategies",
  "strategyConstraints",
  "segments",
  "segmentConstraints",
  "variants",
  "apiTokens",
  "auditLogs",
  "flagDependencies",
  "metricsImpressions",
  "sdkClients",
];

export function storageError(status, message) {
  return Object.assign(new Error(message), { status });
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function inspectJson(value, depth = 0) {
  if (depth > 24)
    throw storageError(422, "State nesting exceeds the supported limit");
  if (typeof value === "number" && !Number.isFinite(value))
    throw storageError(422, "State contains a non-finite number");
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  )
    throw storageError(422, "State contains an unsupported value");
  if (value && typeof value === "object") {
    if (
      !Array.isArray(value) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      throw storageError(422, "State must contain plain JSON objects");
    for (const child of Object.values(value)) inspectJson(child, depth + 1);
  }
}

export function validateState(state) {
  inspectJson(state);
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    !Number.isSafeInteger(state.meta?.version) ||
    state.meta.version < 1 ||
    (state.meta.schemaVersion !== undefined &&
      state.meta.schemaVersion !== 1) ||
    !state.resourceLimits ||
    typeof state.resourceLimits !== "object" ||
    Array.isArray(state.resourceLimits)
  ) {
    throw storageError(
      422,
      "Unsupported state schema; original file was not replaced",
    );
  }
  for (const name of COLLECTIONS) {
    const items = state[name];
    if (!Array.isArray(items) || items.length > 100000)
      throw storageError(422, `Invalid or oversized collection: ${name}`);
    const ids = new Set();
    for (const item of items) {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        typeof item.id !== "string" ||
        !item.id ||
        item.id.length > 128 ||
        ids.has(item.id)
      )
        throw storageError(
          422,
          `Invalid or duplicate record identity: ${name}`,
        );
      ids.add(item.id);
    }
  }
  // This storage boundary checks shape/identity. Resource contracts and service
  // operations additionally enforce relationships and authorization.
  return state;
}

export class PlatformStore {
  #state = null;
  #digest = null;
  #snapshots = new Map();
  #rateLimits = new Map();
  #requests = new AsyncLocalStorage();

  constructor(
    dataFilePath = process.env.FEATURE_FLAGS_DATA_FILE || DEFAULT_DATA_FILE,
    { fsImpl = fs } = {},
  ) {
    this.dataFilePath = path.resolve(dataFilePath);
    this.io = fsImpl;
    this.lockPath = `${this.dataFilePath}.lock`;
  }

  #read() {
    let info;
    try {
      info = this.io.lstatSync(this.dataFilePath);
    } catch (error) {
      if (error.code === "ENOENT")
        throw storageError(
          503,
          "No state file. Run the explicit local setup command first.",
        );
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES)
      throw storageError(422, "State must be a regular file of at most 16 MiB");
    const bytes = this.io.readFileSync(this.dataFilePath);
    if (bytes.length > MAX_STATE_BYTES)
      throw storageError(422, "State exceeds 16 MiB");
    let state;
    try {
      state = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw storageError(
        422,
        "State is not valid UTF-8 JSON; original file was not replaced",
      );
    }
    validateState(state);
    return {
      state,
      digest: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  }

  #accept({ state, digest }) {
    if (digest !== this.#digest) this.#snapshots.clear();
    this.#state = freeze(state);
    this.#digest = digest;
    const request = this.#requests.getStore();
    if (request) Object.assign(request, { state: this.#state, digest });
    return this.#state;
  }

  init() {
    return this.#accept(this.#read());
  }

  getState() {
    const request = this.#requests.getStore();
    if (request) return request.state;
    // Outside a request, refresh so another cooperating process is visible.
    return this.init();
  }

  runRequest(expectedVersion, operation) {
    const current = this.#read();
    const request = {
      state: freeze(current.state),
      digest: current.digest,
      expectedVersion,
    };
    return this.#requests.run(request, operation);
  }

  runOperation(operation) {
    return this.#requests.getStore()
      ? operation()
      : this.runRequest(undefined, operation);
  }

  #withLease(operation) {
    let handle;
    try {
      handle = this.io.openSync(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST")
        throw storageError(
          503,
          "Another writer owns the state lease; retry later",
        );
      throw error;
    }
    try {
      this.io.writeFileSync(
        handle,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
      );
      this.io.fsyncSync(handle);
      return operation();
    } finally {
      this.io.closeSync(handle);
      this.io.unlinkSync(this.lockPath);
    }
  }

  #commit(candidate) {
    validateState(candidate);
    const bytes = Buffer.from(
      JSON.stringify(candidate, null, 2) + "\n",
      "utf8",
    );
    if (bytes.length > MAX_STATE_BYTES)
      throw storageError(
        422,
        "State exceeds 16 MiB; archive data before retrying",
      );
    const temporary = `${this.dataFilePath}.${crypto.randomUUID()}.tmp`;
    let handle;
    let created = false;
    try {
      handle = this.io.openSync(temporary, "wx", 0o600);
      created = true;
      this.io.writeFileSync(handle, bytes);
      this.io.fsyncSync(handle);
      this.io.closeSync(handle);
      handle = undefined;
      this.io.renameSync(temporary, this.dataFilePath);
      created = false;
      // Publish only after successful replacement, using the exact JSON representation.
      return this.#accept({
        state: JSON.parse(bytes.toString("utf8")),
        digest: crypto.createHash("sha256").update(bytes).digest("hex"),
      });
    } finally {
      if (handle !== undefined) this.io.closeSync(handle);
      if (created) this.io.unlinkSync(temporary);
    }
  }

  initialize(initialState) {
    const candidate = structuredClone(initialState);
    candidate.meta = { ...candidate.meta, schemaVersion: 1 };
    validateState(candidate);
    this.io.mkdirSync(path.dirname(this.dataFilePath), { recursive: true });
    return this.#withLease(() => {
      if (this.io.existsSync(this.dataFilePath))
        throw storageError(
          409,
          "Setup refuses to replace an existing state file",
        );
      return this.#commit(candidate);
    });
  }

  mutate(mutator, expectedVersion) {
    if (typeof mutator !== "function")
      throw new TypeError("mutator must be a function");
    const request = this.#requests.getStore();
    expectedVersion ??=
      request?.expectedVersion ??
      request?.state.meta.version ??
      this.#state?.meta.version;
    if (expectedVersion === undefined)
      expectedVersion = this.getState().meta.version;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw storageError(428, "A valid expected version is required");
    return this.#withLease(() => {
      const current = this.#read();
      const expectedDigest = request?.digest ?? this.#digest;
      if (
        current.state.meta.version !== expectedVersion ||
        (expectedDigest !== null && current.digest !== expectedDigest)
      ) {
        this.#accept(current);
        throw storageError(
          409,
          "State changed; reload and review before saving",
        );
      }
      const draft = structuredClone(current.state);
      const result = mutator(draft);
      if (result && typeof result.then === "function")
        throw new TypeError("mutator must be synchronous");
      if (current.state.meta.version >= Number.MAX_SAFE_INTEGER)
        throw storageError(409, "State version limit reached");
      draft.meta = {
        ...draft.meta,
        schemaVersion: 1,
        version: current.state.meta.version + 1,
        updatedAt: new Date().toISOString(),
      };
      const detachedResult = structuredClone(result);
      this.#commit(draft);
      return detachedResult;
    });
  }

  getSnapshot(projectId, environmentId) {
    const state = this.getState();
    const digest = this.#requests.getStore()?.digest ?? this.#digest;
    const key = JSON.stringify([
      projectId,
      environmentId,
      state.meta.version,
      digest,
    ]);
    if (!this.#snapshots.has(key)) {
      if (this.#snapshots.size >= 200)
        this.#snapshots.delete(this.#snapshots.keys().next().value);
      this.#snapshots.set(
        key,
        freeze(compileSnapshot(state, projectId, environmentId)),
      );
    }
    return this.#snapshots.get(key);
  }

  useRateLimit(key, limit, windowMs) {
    if (
      typeof key !== "string" ||
      key.length > 512 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(windowMs) ||
      windowMs < 1
    )
      throw new TypeError("Invalid rate limit parameters");
    const now = Date.now();
    for (const [storedKey, entry] of this.#rateLimits)
      if (entry.resetAt <= now) this.#rateLimits.delete(storedKey);
    if (!this.#rateLimits.has(key) && this.#rateLimits.size >= 10000)
      return false;
    const entry = this.#rateLimits.get(key) ?? {
      count: 0,
      resetAt: now + windowMs,
    };
    entry.count = Math.min(entry.count + 1, limit + 1);
    this.#rateLimits.set(key, entry);
    return entry.count <= limit;
  }
}
