import { createEvaluator } from "./request.js";

export class FeatureFlagServerClient {
  constructor({ debug = false, ...options }) {
    if (typeof debug !== "boolean")
      throw new TypeError("debug must be a boolean");
    this.debug = debug;
    this.request = createEvaluator(options);
  }

  async evaluate(context = {}) {
    return this.request("/api/client/evaluate", context, this.debug);
  }

  async isEnabled(flagKey, context = {}) {
    const flags = await this.evaluate(context);
    return flags.find((flag) => flag.key === flagKey)?.enabled ?? false;
  }

  async getVariant(flagKey, context = {}) {
    const flags = await this.evaluate(context);
    return flags.find((flag) => flag.key === flagKey)?.variant ?? null;
  }
}
