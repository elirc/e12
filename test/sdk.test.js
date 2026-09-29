import test from "node:test";
import assert from "node:assert/strict";
import { FeatureFlagServerClient } from "../sdk/server-sdk.js";
import { FeatureFlagBrowserClient } from "../sdk/browser-sdk.js";

const options = {
  baseUrl: "http://127.0.0.1:3000",
  token: "synthetic-test-token",
};
const flag = (enabled) => ({
  key: "checkout",
  enabled,
  variant: { name: "control", payload: { color: "blue" } },
});
const response = (flags, status = 200) => ({
  status,
  json: async () => ({ flags }),
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("server SDK submits each context without a configuration conditional header", async () => {
  const requests = [];
  const client = new FeatureFlagServerClient({
    ...options,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return response([flag(JSON.parse(init.body).context.plan === "pro")]);
    },
  });
  assert.equal(await client.isEnabled("checkout", { plan: "pro" }), true);
  assert.equal(await client.isEnabled("checkout", { plan: "free" }), false);
  assert.equal(requests.length, 2);
  assert.ok(
    requests.every(
      ({ init }) =>
        !("If-None-Match" in init.headers) && init.cache === "no-store",
    ),
  );
});

test("server SDK rejects a 304 instead of returning a prior user's flags", async () => {
  const client = new FeatureFlagServerClient({
    ...options,
    fetchImpl: async () => response([], 304),
  });
  await assert.rejects(client.evaluate({}), /status 304/);
});

test("overlapping browser refreshes return their results but only latest context publishes", async () => {
  const first = deferred(),
    second = deferred();
  let count = 0;
  const client = new FeatureFlagBrowserClient({
    ...options,
    fetchImpl: () => (++count === 1 ? first.promise : second.promise),
  });
  const a = client.refresh({ userId: "a" });
  const b = client.refresh({ userId: "b" });
  second.resolve(response([flag(false)]));
  assert.equal((await b).get("checkout").enabled, false);
  first.resolve(response([flag(true)]));
  assert.equal((await a).get("checkout").enabled, true);
  assert.equal(client.get("checkout").enabled, false);
});

test("pending and failed refreshes do not expose a previous context's flags", async () => {
  const next = deferred();
  let count = 0;
  const client = new FeatureFlagBrowserClient({
    ...options,
    fetchImpl: () =>
      ++count === 1 ? Promise.resolve(response([flag(true)])) : next.promise,
  });
  await client.refresh({ userId: "a" });
  const pending = client.refresh({ userId: "b" });
  assert.equal(client.get("checkout").enabled, false);
  next.resolve(response([], 503));
  await assert.rejects(pending, /503/);
  assert.equal(client.flags.size, 0);
});

test("clearing browser state prevents an in-flight response from republishing", async () => {
  const pending = deferred();
  const client = new FeatureFlagBrowserClient({
    ...options,
    fetchImpl: () => pending.promise,
  });
  const request = client.refresh({});
  client.clear();
  pending.resolve(response([flag(true)]));
  await request;
  assert.equal(client.flags.size, 0);
});

test("returned maps and nested variants cannot mutate the accepted browser state", async () => {
  const client = new FeatureFlagBrowserClient({
    ...options,
    fetchImpl: async () => response([flag(true)]),
  });
  const result = await client.refresh({});
  result.get("checkout").variant.payload.color = "red";
  client.flags.clear();
  client.get("checkout").enabled = false;
  assert.equal(client.get("checkout").enabled, true);
  assert.equal(client.get("checkout").variant.payload.color, "blue");
});

test("each subscriber receives an isolated snapshot and exceptions do not stop others", async () => {
  const client = new FeatureFlagBrowserClient({
    ...options,
    fetchImpl: async () => response([flag(true)]),
  });
  const seen = [];
  const unsubscribe = client.subscribe((flags) => {
    flags.clear();
    throw new Error("Synthetic observer failure");
  });
  client.subscribe((flags) => seen.push(flags.size));
  await client.refresh({});
  assert.deepEqual(seen, [0, 1]);
  assert.equal(client.listenerErrors.length, 2);
  unsubscribe();
  client.clear();
  assert.equal(client.listenerErrors.length, 2);
});

test("malformed response flags and duplicate keys are rejected", async () => {
  for (const flags of [
    null,
    [{ ...flag(true), enabled: "true" }],
    [flag(true), flag(false)],
    [{ ...flag(true), variant: [] }],
  ]) {
    const client = new FeatureFlagServerClient({
      ...options,
      fetchImpl: async () => response(flags),
    });
    await assert.rejects(client.evaluate({}), /Invalid evaluation/);
  }
});

test("request timeout aborts the fetch and rejects the caller", async () => {
  const client = new FeatureFlagServerClient({
    ...options,
    timeoutMs: 20,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("Synthetic fetch aborted")),
          { once: true },
        );
      }),
  });
  await assert.rejects(client.evaluate({}), /aborted/);
});

test("invalid options and oversized or non-object contexts fail before sending", async () => {
  assert.throws(
    () =>
      new FeatureFlagServerClient({ ...options, baseUrl: "file:///tmp/data" }),
    /HTTP/,
  );
  assert.throws(
    () => new FeatureFlagServerClient({ ...options, timeoutMs: 0 }),
    /timeoutMs/,
  );
  assert.throws(
    () => new FeatureFlagServerClient({ ...options, debug: "yes" }),
    /debug/,
  );
  let calls = 0;
  const client = new FeatureFlagServerClient({
    ...options,
    fetchImpl: async () => {
      calls++;
      return response([]);
    },
  });
  for (const context of [null, [], "abc", { text: "x".repeat(66000) }])
    await assert.rejects(client.evaluate(context), /context|64 KiB/);
  assert.equal(calls, 0);
});
