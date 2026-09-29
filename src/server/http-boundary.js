import crypto from "node:crypto";

const bodyResult = Symbol("parsed JSON body");
export const MAX_BODY_BYTES = 65536;
export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function secureResponse(response) {
  const requestId = crypto.randomUUID();
  response.setHeader("X-Request-Id", requestId);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  return requestId;
}

export function validateRequest(request) {
  const port = request.socket.localPort;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (port === 80) {
    hosts.add("127.0.0.1");
    hosts.add("localhost");
  }
  if (!hosts.has(request.headers.host))
    throw httpError(400, "Use the loopback application host");
  if (
    typeof request.url !== "string" ||
    request.url.length > 2048 ||
    !request.url.startsWith("/") ||
    request.url.startsWith("//") ||
    request.url.includes("#")
  )
    throw httpError(400, "Invalid request URL");
  if (!["GET", "HEAD", "POST", "PATCH", "DELETE"].includes(request.method))
    throw httpError(405, "Method not supported");
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.origin !== `http://${request.headers.host}`)
    throw httpError(400, "Invalid request target");
  if (["POST", "PATCH", "DELETE"].includes(request.method)) {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== url.origin)
      throw httpError(403, "Cross-origin writes are not allowed");
    if (request.headers["sec-fetch-site"] === "cross-site")
      throw httpError(403, "Cross-site writes are not allowed");
    if (
      request.headers["content-encoding"] &&
      request.headers["content-encoding"] !== "identity"
    )
      throw httpError(415, "Compressed request bodies are not supported");
  }
  return url;
}

export function writeVersion(request, url) {
  const adminWrite =
    ["POST", "PATCH", "DELETE"].includes(request.method) &&
    url.pathname.startsWith("/api/admin/") &&
    url.pathname !== "/api/admin/playground";
  if (!adminWrite) return undefined;
  const value = request.headers["if-match"];
  if (typeof value !== "string" || !/^"[1-9][0-9]{0,15}"$/.test(value))
    throw httpError(
      428,
      'Supply the reviewed workspace version as If-Match: "1"',
    );
  const version = Number(value.slice(1, -1));
  if (!Number.isSafeInteger(version))
    throw httpError(428, "Invalid workspace version");
  return version;
}

function inspect(value, depth = 0) {
  if (depth > 10) throw httpError(422, "JSON nesting exceeds 10 levels");
  if (typeof value === "number" && !Number.isFinite(value))
    throw httpError(422, "JSON numbers must be finite");
  if (
    typeof value === "string" &&
    (value.length > 20000 || !value.isWellFormed())
  )
    throw httpError(
      422,
      "JSON string is too long or contains an invalid Unicode sequence",
    );
  if (Array.isArray(value) && value.length > 2000)
    throw httpError(422, "JSON array exceeds 2000 items");
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!Array.isArray(value) && entries.length > 1000)
      throw httpError(422, "JSON object exceeds 1000 fields");
    for (const [key, child] of entries) {
      if (
        key.length > 128 ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        throw httpError(422, "Unsupported JSON field name");
      inspect(child, depth + 1);
    }
  }
}

export function readJsonBody(request) {
  if (request[bodyResult]) return request[bodyResult];
  request[bodyResult] = new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const fail = (error) => {
      cleanup();
      request.pause();
      error.closeConnection = true;
      reject(error);
    };
    const onError = () =>
      fail(httpError(400, "Request body could not be read"));
    const onAborted = () =>
      fail(httpError(400, "Request body was interrupted"));
    const onData = (chunk) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES)
        return fail(httpError(413, "Request body exceeds 64 KiB"));
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        if (
          length &&
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            request.headers["content-type"] || "",
          )
        )
          throw httpError(415, "Use application/json with UTF-8");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks),
        );
        const body = text.trim() ? JSON.parse(text) : {};
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw httpError(422, "Request body must be a JSON object");
        inspect(body);
        resolve(body);
      } catch (error) {
        reject(error.status ? error : httpError(400, "Invalid UTF-8 JSON"));
      }
    };
    const declared = request.headers["content-length"];
    if (
      declared !== undefined &&
      (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)
    )
      return fail(httpError(413, "Request body exceeds 64 KiB"));
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
  return request[bodyResult];
}
