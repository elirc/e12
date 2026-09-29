export class FeatureFlagBrowserClient {
  constructor({ baseUrl, token }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.flags = new Map();
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      listener(this.flags);
    }
  }

  async refresh(context = {}) {
    const response = await fetch(`${this.baseUrl}/api/client/features`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ context }),
    });
    if (!response.ok) {
      throw new Error(`Feature refresh failed with status ${response.status}`);
    }
    const payload = await response.json();
    this.flags = new Map(payload.flags.map((flag) => [flag.key, flag]));
    this.notify();
    return this.flags;
  }

  get(flagKey) {
    return this.flags.get(flagKey) ?? { enabled: false, variant: null };
  }
}
