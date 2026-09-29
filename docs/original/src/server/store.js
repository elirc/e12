import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileSnapshot } from "../core/snapshot.js";
import { buildSeedState } from "./defaults.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_FILE = path.resolve(__dirname, "../../data/state.json");

export class PlatformStore {
  constructor(dataFilePath = DEFAULT_DATA_FILE) {
    this.dataFilePath = dataFilePath;
    this.state = null;
    this.snapshotCache = new Map();
    this.rateLimits = new Map();
  }

  init() {
    const directory = path.dirname(this.dataFilePath);
    fs.mkdirSync(directory, { recursive: true });

    if (!fs.existsSync(this.dataFilePath)) {
      this.state = buildSeedState();
      this.persist();
      return this.state;
    }

    const contents = fs.readFileSync(this.dataFilePath, "utf8");
    this.state = JSON.parse(contents);
    return this.state;
  }

  getState() {
    if (!this.state) {
      return this.init();
    }
    return this.state;
  }

  persist() {
    fs.writeFileSync(this.dataFilePath, JSON.stringify(this.state, null, 2));
  }

  mutate(mutator) {
    const draft = structuredClone(this.getState());
    const result = mutator(draft);
    draft.meta.version += 1;
    draft.meta.updatedAt = new Date().toISOString();
    this.state = draft;
    this.snapshotCache.clear();
    this.persist();
    return result;
  }

  getSnapshot(projectId, environmentId) {
    const state = this.getState();
    const cacheKey = `${projectId}:${environmentId}:${state.meta.version}`;
    if (!this.snapshotCache.has(cacheKey)) {
      this.snapshotCache.set(cacheKey, compileSnapshot(state, projectId, environmentId));
    }
    return this.snapshotCache.get(cacheKey);
  }

  useRateLimit(key, limit, windowMs) {
    const now = Date.now();
    const entry = this.rateLimits.get(key) ?? { count: 0, resetAt: now + windowMs };
    if (entry.resetAt < now) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }
    entry.count += 1;
    this.rateLimits.set(key, entry);
    return entry.count <= limit;
  }
}
