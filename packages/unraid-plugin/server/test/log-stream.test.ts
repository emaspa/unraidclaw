import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../src/config.js";

const flash = await mkdtemp(join(tmpdir(), "unraidclaw-log-test-"));
process.env.FLASH_BASE = flash;
const { loadConfig } = await import("../src/config.js");
const { hashApiKey } = await import("../src/auth.js");
const { createServer } = await import("../src/server.js");
const { createLogStream } = await import("../src/log-stream.js");

// Every write to /dev/full fails with ENOSPC, like a full /var/log tmpfs.
const full = openSync("/dev/full", "w");
const config: ServerConfig = {
  ...loadConfig(), mcpEnabled: false, port: 9876, host: "127.0.0.1",
  apiKeyHash: hashApiKey(randomBytes(32).toString("hex")), graphqlUrl: "http://127.0.0.1:1/graphql",
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Network is forbidden in log tests"); };
after(async () => {
  globalThis.fetch = originalFetch;
  closeSync(full);
  await rm(flash, { recursive: true, force: true });
});

test("a log line that cannot be written is dropped without an error", async () => {
  const stream = createLogStream(full);
  const errors: unknown[] = [];
  stream.on("error", (err) => errors.push(err));
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve, reject) => stream.write(`{"line":${i}}\n`, (err) => (err ? reject(err) : resolve())));
  }
  await new Promise<void>((resolve) => stream.end(resolve));
  assert.deepEqual(errors, []);
  assert.equal(stream.destroyed, true);
  assert.equal(stream.errored, null);
});

test("the server keeps answering and closes when its log is unwritable", async (t) => {
  const app = createServer(config, undefined, createLogStream(full));
  t.after(() => app.close());
  for (let i = 0; i < 5; i++) {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  }
  await app.close();
});
