import crypto from "node:crypto";

export function stableHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function hashToken(token) {
  return stableHash(`token:${token}`);
}

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function bucketValue(input, range = 100) {
  const digest = stableHash(input);
  const numeric = Number.parseInt(digest.slice(0, 12), 16);
  return (numeric % range) + 1;
}
