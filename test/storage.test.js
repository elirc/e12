import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PlatformStore } from "../src/server/store.js";
import { buildSeedState } from "../src/server/defaults.js";
import { buildOwnerState, runSetup } from "../src/server/setup.js";
import { hashToken } from "../src/core/hash.js";
import { SEED_TOKENS } from "../src/core/constants.js";

function fixture(t, { initialize = true, fsImpl = fs } = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "feature-flags-storage-"),
  );
  const file = path.join(directory, "state.json");
  t.after(() => {
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    assert.ok(path.basename(directory).startsWith("feature-flags-storage-"));
    // Only unlink direct files in this test's own new directory; no recursive removal.
    for (const name of fs.readdirSync(directory))
      fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  const store = new PlatformStore(file, { fsImpl });
  if (initialize) store.initialize(buildSeedState());
  return { directory, file, store };
}

test("missing state requires explicit setup without creating demo credentials", (t) => {
  const { store, file } = fixture(t, { initialize: false });
  assert.throws(() => store.init(), /explicit local setup/);
  assert.equal(fs.existsSync(file), false);
});

test("setup refuses to overwrite an existing state", (t) => {
  const { store, file } = fixture(t);
  const before = fs.readFileSync(file);
  assert.throws(() => store.initialize(buildSeedState()), /refuses to replace/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("mutation persists before publishing and survives reopening", (t) => {
  const { store, file } = fixture(t);
  const version = store.getState().meta.version;
  const result = store.mutate((draft) => {
    draft.projects[0].name = "Accepted";
    return draft.projects[0];
  }, version);
  result.name = "Caller mutation";
  const reopened = new PlatformStore(file).init();
  assert.equal(reopened.projects[0].name, "Accepted");
  assert.equal(reopened.meta.version, version + 1);
});

test("failed replacement preserves accepted disk and memory state and cleans temporary files", (t) => {
  let fail = false;
  const { store, file, directory } = fixture(t, {
    fsImpl: {
      ...fs,
      renameSync: (...args) => {
        if (fail)
          throw Object.assign(new Error("Injected replace failure"), {
            code: "EACCES",
          });
        return fs.renameSync(...args);
      },
    },
  });
  const before = fs.readFileSync(file);
  const accepted = store.getState();
  fail = true;
  assert.throws(
    () =>
      store.mutate((draft) => {
        draft.projects[0].name = "Not accepted";
      }),
    /Injected/,
  );
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(store.getState().projects[0].name, accepted.projects[0].name);
  assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
});

test("mutator exceptions do not change accepted state", (t) => {
  const { store, file } = fixture(t);
  const before = fs.readFileSync(file);
  assert.throws(
    () =>
      store.mutate((draft) => {
        draft.projects.length = 0;
        throw new Error("Reject operation");
      }),
    /Reject operation/,
  );
  assert.deepEqual(fs.readFileSync(file), before);
});

test("two store instances reject a stale edit and retain the winning change", (t) => {
  const { store: first, file } = fixture(t);
  const second = new PlatformStore(file);
  const oldVersion = second.init().meta.version;
  first.mutate((draft) => {
    draft.projects[0].name = "First writer";
  });
  assert.throws(
    () =>
      second.mutate((draft) => {
        draft.projects[0].name = "Stale writer";
      }, oldVersion),
    /changed/,
  );
  assert.equal(second.getState().projects[0].name, "First writer");
  second.mutate((draft) => {
    draft.projects[0].description = "Reviewed latest";
  });
  assert.equal(first.getState().projects[0].description, "Reviewed latest");
});

test("same-version external edits are detected by their bytes", (t) => {
  const { store, file } = fixture(t);
  const changed = JSON.parse(fs.readFileSync(file, "utf8"));
  changed.projects[0].name = "External edit";
  fs.writeFileSync(file, JSON.stringify(changed));
  assert.throws(
    () =>
      store.mutate((draft) => {
        draft.projects[0].name = "Overwrite";
      }),
    /changed/,
  );
  assert.equal(store.getState().projects[0].name, "External edit");
});

test("existing writer lease is never stolen or removed", (t) => {
  const { store, file } = fixture(t);
  const lease = "Synthetic other writer lease";
  fs.writeFileSync(`${file}.lock`, lease, { flag: "wx" });
  assert.throws(() => store.mutate(() => {}), /Another writer/);
  assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), lease);
});

test("read snapshots cannot be mutated outside the storage boundary", (t) => {
  const { store } = fixture(t);
  const state = store.getState();
  assert.throws(() => {
    state.projects[0].name = "Escape";
  }, TypeError);
  const snapshot = store.getSnapshot(
    state.projects[0].id,
    state.projectEnvironments[0].environmentId,
  );
  assert.throws(() => {
    snapshot.flags[0].flag.name = "Escape";
  }, TypeError);
});

test("malformed or unknown-schema state is refused without replacement", (t) => {
  const { store, file } = fixture(t);
  const initial = fs.readFileSync(file);
  const future = JSON.parse(initial);
  future.meta.schemaVersion = 999;
  for (const bytes of [
    Buffer.from("{broken"),
    Buffer.from([0xff]),
    Buffer.from(JSON.stringify(future)),
  ]) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => store.init(), /schema|UTF-8/);
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
});

test("duplicate identities and non-finite values fail before replacement", (t) => {
  const { store, file } = fixture(t);
  const before = fs.readFileSync(file);
  assert.throws(
    () =>
      store.mutate((draft) => {
        draft.projects.push({ ...draft.projects[0] });
      }),
    /duplicate/,
  );
  assert.throws(
    () =>
      store.mutate((draft) => {
        draft.resourceLimits.maxProjects = Infinity;
      }),
    /non-finite/,
  );
  assert.deepEqual(fs.readFileSync(file), before);
});

test("oversized state fails without a partial write", (t) => {
  const { store, file } = fixture(t);
  const before = fs.readFileSync(file);
  assert.throws(
    () =>
      store.mutate((draft) => {
        draft.projects[0].description = "x".repeat(16 * 1024 * 1024);
      }),
    /16 MiB/,
  );
  assert.deepEqual(fs.readFileSync(file), before);
});

test("owner setup issues a fresh token and removes known fixture tokens", () => {
  const first = buildOwnerState({
    name: "Owner",
    email: "Owner@example.invalid",
  });
  const second = buildOwnerState({
    name: "Owner",
    email: "owner@example.invalid",
  });
  assert.notEqual(first.plaintext, second.plaintext);
  assert.equal(first.state.apiTokens.length, 1);
  assert.equal(first.state.apiTokens[0].hash, hashToken(first.plaintext));
  assert.ok(!JSON.stringify(first.state).includes(first.plaintext));
  assert.ok(
    Object.values(SEED_TOKENS).every(
      (token) => first.state.apiTokens[0].hash !== hashToken(token),
    ),
  );
});

test("demo setup requires explicit acknowledgment and never overwrites existing data", (t) => {
  const { store, file } = fixture(t, { initialize: false });
  const messages = [];
  assert.throws(
    () => runSetup(["demo"], { store, output: (text) => messages.push(text) }),
    /Usage/,
  );
  assert.equal(fs.existsSync(file), false);
  runSetup(["demo", "--acknowledge-local-only"], {
    store,
    output: (text) => messages.push(text),
  });
  assert.equal(messages.length, 1);
  assert.throws(
    () => runSetup(["demo", "--acknowledge-local-only"], { store }),
    /refuses/,
  );
});

test("rate limiter enforces its window and validates parameters", (t) => {
  const { store } = fixture(t);
  assert.equal(store.useRateLimit("synthetic", 2, 60000), true);
  assert.equal(store.useRateLimit("synthetic", 2, 60000), true);
  assert.equal(store.useRateLimit("synthetic", 2, 60000), false);
  assert.throws(() => store.useRateLimit("x", 0, 60000), /Invalid/);
});

test("a request keeps a consistent read snapshot across awaits and rejects a competing write", async (t) => {
  const { store } = fixture(t);
  const original = store.getState();
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const pending = store.runRequest(original.meta.version, async () => {
    assert.equal(store.getState().projects[0].name, original.projects[0].name);
    await barrier;
    assert.equal(store.getState().projects[0].name, original.projects[0].name);
    assert.throws(
      () =>
        store.mutate((draft) => {
          draft.projects[0].name = "Stale request";
        }),
      /changed/,
    );
  });
  store.runRequest(original.meta.version, () =>
    store.mutate((draft) => {
      draft.projects[0].name = "Winner";
    }),
  );
  release();
  await pending;
  assert.equal(store.getState().projects[0].name, "Winner");
});

test("an explicit request version is not replaced by a newer read", (t) => {
  const { store } = fixture(t);
  const oldVersion = store.getState().meta.version;
  store.mutate((draft) => {
    draft.projects[0].name = "New revision";
  });
  store.runRequest(oldVersion, () => {
    assert.equal(store.getState().meta.version, oldVersion + 1);
    assert.throws(() => store.mutate(() => {}), /changed/);
  });
});

test("legacy files without schemaVersion are readable without automatic rewriting", (t) => {
  const { store, file } = fixture(t);
  const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
  delete legacy.meta.schemaVersion;
  const bytes = JSON.stringify(legacy);
  fs.writeFileSync(file, bytes);
  assert.equal(store.init().meta.version, legacy.meta.version);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
});

test("generated seed datasets do not share mutable limits or permission arrays", () => {
  const first = buildSeedState();
  const second = buildSeedState();
  first.resourceLimits.maxFlagsPerProject = 1;
  first.roles[0].scopes.length = 0;
  first.permissions[0].scopes.length = 0;
  assert.equal(second.resourceLimits.maxFlagsPerProject, 200);
  assert.ok(second.roles[0].scopes.length > 0);
  assert.ok(second.permissions[0].scopes.length > 0);
  assert.equal(buildSeedState().resourceLimits.maxFlagsPerProject, 200);
});
