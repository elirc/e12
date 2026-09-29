import { createEvaluator } from "./request.js";

export class FeatureFlagBrowserClient {
  #flags = new Map();
  #sequence = 0;

  constructor(options) {
    this.request = createEvaluator(options);
    this.listeners = new Set();
    this.listenerErrors = [];
  }

  get flags() {
    return structuredClone(this.#flags);
  }

  subscribe(listener) {
    if (typeof listener !== "function")
      throw new TypeError("listener must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      try {
        listener(this.flags);
      } catch (error) {
        // Observer code must not prevent later observers from receiving accepted state.
        this.listenerErrors.push(error);
        if (this.listenerErrors.length > 10) this.listenerErrors.shift();
      }
    }
  }

  async refresh(context = {}) {
    const sequence = ++this.#sequence;
    // Do not expose the prior identity's flags while a different context loads.
    this.#flags = new Map();
    this.notify();
    const flags = await this.request("/api/client/features", context);
    const result = new Map(flags.map((flag) => [flag.key, flag]));
    if (sequence === this.#sequence) {
      this.#flags = result;
      this.notify();
    }
    // The caller gets its own request result; only the latest request publishes.
    return structuredClone(result);
  }

  clear() {
    this.#sequence++;
    this.#flags = new Map();
    this.notify();
  }

  get(flagKey) {
    return structuredClone(
      this.#flags.get(flagKey) ?? { enabled: false, variant: null },
    );
  }
}
