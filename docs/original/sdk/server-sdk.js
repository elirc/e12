export class FeatureFlagServerClient {
  constructor({ baseUrl, token, debug = false }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.debug = debug;
    this.etag = null;
    this.cachedFlags = [];
  }

  async evaluate(context = {}) {
    const response = await fetch(`${this.baseUrl}/api/client/evaluate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        ...(this.etag ? { "If-None-Match": this.etag } : {}),
      },
      body: JSON.stringify({ context, debug: this.debug }),
    });

    if (response.status === 304) {
      return this.cachedFlags;
    }

    if (!response.ok) {
      throw new Error(`Evaluation failed with status ${response.status}`);
    }

    this.etag = response.headers.get("etag");
    const payload = await response.json();
    this.cachedFlags = payload.flags;
    return payload.flags;
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
