// Both SDKs evaluate the submitted context every time; configuration revisions
// are diagnostic metadata and never a cache key for a user's result.
export function createEvaluator({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
}) {
  const url = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      "baseUrl must be an HTTP(S) URL without credentials, query or fragment",
    );
  }
  if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token))
    throw new TypeError("A token is required");
  if (typeof fetchImpl !== "function")
    throw new TypeError("fetchImpl must be a function");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new TypeError("timeoutMs must be 1..120000");
  const base = url.href.replace(/\/$/, "");
  return async (endpoint, context, debug = false) => {
    if (!context || typeof context !== "object" || Array.isArray(context))
      throw new TypeError("context must be an object");
    const body = JSON.stringify({ context, debug });
    if (new TextEncoder().encode(body).length > 65536)
      throw new TypeError("Evaluation request exceeds 64 KiB");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}${endpoint}`, {
        method: "POST",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body,
      });
      if (response.status !== 200)
        throw new Error(`Evaluation failed with status ${response.status}`);
      const payload = await response.json();
      if (
        !payload ||
        !Array.isArray(payload.flags) ||
        payload.flags.length > 5000
      )
        throw new Error("Invalid evaluation response");
      const keys = new Set();
      for (const flag of payload.flags) {
        if (
          !flag ||
          typeof flag.key !== "string" ||
          !flag.key ||
          flag.key.length > 128 ||
          keys.has(flag.key) ||
          typeof flag.enabled !== "boolean" ||
          !(
            flag.variant === null ||
            (typeof flag.variant === "object" &&
              !Array.isArray(flag.variant) &&
              flag.variant !== null)
          )
        ) {
          throw new Error("Invalid evaluation flag");
        }
        keys.add(flag.key);
      }
      return structuredClone(payload.flags);
    } finally {
      clearTimeout(timer);
    }
  };
}
