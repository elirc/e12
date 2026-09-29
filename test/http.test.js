import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { PlatformStore } from "../src/server/store.js";
import { buildSeedState } from "../src/server/defaults.js";
import { createAppServer } from "../src/server/server.js";
import { SEED_TOKENS } from "../src/core/constants.js";

async function fixture(t, { alter = () => {}, fsImpl = fs } = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "feature-flags-http-"),
  );
  const file = path.join(directory, "state.json");
  const store = new PlatformStore(file, { fsImpl });
  const state = buildSeedState();
  alter(state);
  store.initialize(state);
  const server = createAppServer({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    assert.ok(path.basename(directory).startsWith("feature-flags-http-"));
    for (const name of fs.readdirSync(directory))
      fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = {
    Authorization: `Bearer ${SEED_TOKENS.admin}`,
    "Content-Type": "application/json",
  };
  return {
    store,
    file,
    base,
    admin,
    projectId: state.projects[0].id,
    environmentId: state.projectEnvironments[0].environmentId,
  };
}

test("loopback pages and API responses have defensive headers and consistent revisions", async (t) => {
  const { base, admin } = await fixture(t);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  const response = await fetch(`${base}/api/admin/bootstrap`, {
    headers: admin,
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), `"${body.revision}"`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
});

test("unexpected Host and cross-origin mutation requests are rejected", async (t) => {
  const { base, admin, store } = await fixture(t);
  // Fetch normalizes Host in this Node version; use the HTTP client to put
  // the deliberately wrong header on the actual wire.
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.get(
      base,
      { headers: { Host: "unexpected.example" } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
  });
  assert.equal(wrongHost, 400);
  const version = store.getState().meta.version;
  const response = await fetch(`${base}/api/admin/projects`, {
    method: "POST",
    headers: {
      ...admin,
      Origin: "https://unrelated.example",
      "If-Match": `"${version}"`,
    },
    body: "{}",
  });
  assert.equal(response.status, 403);
  assert.equal(store.getState().meta.version, version);
});

test("malformed UTF-8 and JSON return useful client errors", async (t) => {
  const { base, admin } = await fixture(t);
  for (const body of [Buffer.from([0xff]), "{unfinished"]) {
    const response = await fetch(`${base}/api/client/evaluate`, {
      method: "POST",
      headers: admin,
      body,
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /UTF-8 JSON/);
  }
});

test("non-object, non-finite, malformed Unicode and excessively nested JSON are refused", async (t) => {
  const { base, admin } = await fixture(t);
  let nested = {};
  for (let i = 0; i < 12; i++) nested = { child: nested };
  const values = [
    "[]",
    "null",
    '{"context":{"age":1e999}}',
    JSON.stringify({ context: { value: "\ud800" } }),
    JSON.stringify(nested),
  ];
  for (const body of values) {
    const response = await fetch(`${base}/api/client/evaluate`, {
      method: "POST",
      headers: admin,
      body,
    });
    assert.equal(response.status, 422);
  }
});

test("non-JSON media types and compressed bodies are refused", async (t) => {
  const { base, admin } = await fixture(t);
  for (const extra of [
    { "Content-Type": "text/plain" },
    { "Content-Encoding": "gzip" },
  ]) {
    const response = await fetch(`${base}/api/client/evaluate`, {
      method: "POST",
      headers: { ...admin, ...extra },
      body: "{}",
    });
    assert.equal(response.status, 415);
  }
});

test("declared and chunked bodies are bounded by actual bytes", async (t) => {
  const { base, admin } = await fixture(t);
  const body = " ".repeat(65537);
  const response = await fetch(`${base}/api/client/evaluate`, {
    method: "POST",
    headers: admin,
    body,
  });
  assert.equal(response.status, 413);
  const status = await new Promise((resolve, reject) => {
    const request = http.request(
      `${base}/api/client/evaluate`,
      { method: "POST", headers: admin },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.setTimeout(10000, () =>
      request.destroy(new Error("Chunked fixture timeout")),
    );
    request.write(" ".repeat(33000));
    request.write(" ".repeat(33000));
    request.end();
  });
  assert.equal(status, 413);
});

test("administration writes require the reviewed If-Match version", async (t) => {
  const { base, admin } = await fixture(t);
  for (const value of [undefined, "1", "*", 'W/"1"']) {
    const headers = { ...admin };
    if (value !== undefined) headers["If-Match"] = value;
    const response = await fetch(`${base}/api/admin/projects`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(response.status, 428);
  }
});

test("two browser drafts cannot silently overwrite a newer workspace revision", async (t) => {
  const { base, admin, environmentId, store } = await fixture(t);
  const bootstrap = await fetch(`${base}/api/admin/bootstrap`, {
    headers: admin,
  });
  const version = bootstrap.headers.get("etag");
  const input = {
    name: "Accepted project",
    key: "accepted",
    environmentIds: [environmentId],
  };
  const first = await fetch(`${base}/api/admin/projects`, {
    method: "POST",
    headers: { ...admin, "If-Match": version },
    body: JSON.stringify(input),
  });
  assert.equal(first.status, 201);
  assert.notEqual(first.headers.get("etag"), version);
  const second = await fetch(`${base}/api/admin/projects`, {
    method: "POST",
    headers: { ...admin, "If-Match": version },
    body: JSON.stringify({ ...input, key: "stale" }),
  });
  assert.equal(second.status, 409);
  assert.ok(
    !store.getState().projects.some((project) => project.key === "stale"),
  );
});

test("evaluation POST ignores configuration conditional headers and reevaluates context", async (t) => {
  const { base } = await fixture(t, {
    alter: (state) => {
      state.strategies.find(
        (item) => item.type === "gradual_rollout",
      ).parameters.rollout = 100;
    },
  });
  const headers = {
    Authorization: `Bearer ${SEED_TOKENS.client}`,
    "Content-Type": "application/json",
  };
  const first = await fetch(`${base}/api/client/evaluate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ context: { userId: "a", plan: "pro" } }),
  });
  const firstBody = await first.json();
  assert.equal(
    firstBody.flags.find((flag) => flag.key === "checkout_redesign").enabled,
    true,
  );
  const second = await fetch(`${base}/api/client/evaluate`, {
    method: "POST",
    headers: { ...headers, "If-None-Match": firstBody.etag },
    body: JSON.stringify({ context: { userId: "b", plan: "free" } }),
  });
  assert.equal(second.status, 200);
  assert.equal(
    (await second.json()).flags.find((flag) => flag.key === "checkout_redesign")
      .enabled,
    false,
  );
});

test("invalid boolean filters are not silently interpreted as false", async (t) => {
  const { base, admin } = await fixture(t);
  assert.equal(
    (await fetch(`${base}/api/admin/flags?archived=banana`, { headers: admin }))
      .status,
    422,
  );
});

test("unexpected storage errors return generic messages without changing data", async (t) => {
  let fail = false;
  const { base, admin, store, file, environmentId } = await fixture(t, {
    fsImpl: {
      ...fs,
      renameSync: (...args) => {
        if (fail) throw new Error("Sensitive synthetic storage detail");
        return fs.renameSync(...args);
      },
    },
  });
  const before = fs.readFileSync(file);
  const version = store.getState().meta.version;
  fail = true;
  const response = await fetch(`${base}/api/admin/projects`, {
    method: "POST",
    headers: { ...admin, "If-Match": `"${version}"` },
    body: JSON.stringify({
      name: "Failure",
      key: "failure",
      environmentIds: [environmentId],
    }),
  });
  assert.equal(response.status, 500);
  assert.equal(
    (await response.json()).error,
    "The operation could not be completed",
  );
  assert.deepEqual(fs.readFileSync(file), before);
});
