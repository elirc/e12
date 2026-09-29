import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { PlatformStore } from "./store.js";
import { buildSeedState } from "./defaults.js";
import { hashToken } from "../core/hash.js";

export function buildOwnerState({ name, email }) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 100 ||
    /[\x00-\x1f]/.test(name)
  )
    throw new Error("Owner name must be 1..100 characters without controls");
  if (
    typeof email !== "string" ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  )
    throw new Error("A valid owner email is required");
  const state = buildSeedState();
  const plaintext = crypto.randomBytes(32).toString("hex");
  state.users[0].name = name.trim();
  state.users[0].email = email.trim().toLowerCase();
  state.apiTokens = [
    {
      ...state.apiTokens[0],
      name: "Initial owner token",
      hash: hashToken(plaintext),
    },
  ];
  return { state, plaintext };
}

export function runSetup(
  args,
  { store = new PlatformStore(), output = console.log } = {},
) {
  if (
    args.length === 2 &&
    args[0] === "demo" &&
    args[1] === "--acknowledge-local-only"
  ) {
    store.initialize(buildSeedState());
    output(
      "Created a disposable demo dataset with the known README fixture tokens. Keep it local.",
    );
    return;
  }
  if (args.length === 3 && args[0] === "owner") {
    const { state, plaintext } = buildOwnerState({
      name: args[1],
      email: args[2],
    });
    store.initialize(state);
    output(
      "Created an owner and example rollout configuration. Save this new personal token privately; it is shown once:",
    );
    output(plaintext);
    return;
  }
  throw new Error(
    'Usage: node src/server/setup.js owner "Your name" "you@example.com" OR demo --acknowledge-local-only',
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runSetup(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
