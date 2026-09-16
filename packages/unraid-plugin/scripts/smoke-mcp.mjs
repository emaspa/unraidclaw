// Exercise only a throwaway gateway on loopback. Never load host configuration.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "unraidclaw-mcp-smoke-"));
let child;
let exited;
try {
  // Loading outside the checkout proves that no runtime node_modules are needed.
  const bundle = join(directory, "index.cjs");
  await copyFile(new URL("../server/dist/index.cjs", import.meta.url), bundle);
  const key = randomBytes(32).toString("hex");
  const logFile = join(directory, "gateway.log");
  const logFd = openSync(logFile, "w", 0o600);
  child = spawn(process.execPath, [bundle], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      FLASH_BASE: directory,
      OCC_HOST: "127.0.0.1", OCC_PORT: "0", OCC_MCP_ENABLED: "yes",
      OCC_API_KEY_HASH: createHash("sha256").update(key).digest("hex"),
      OCC_GRAPHQL_URL: "http://127.0.0.1:1/graphql",
      OCC_VERSION: "smoke-test",
    },
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  exited = once(child, "exit");
  let address;
  const deadline = Date.now() + 10_000;
  while (!address) {
    const output = await readFile(logFile, "utf8");
    const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) {
      address = match[1];
    } else if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Gateway exited before listening: ${output.replaceAll(key, "[redacted]")}`);
    } else if (Date.now() >= deadline) {
      throw new Error("Gateway startup timed out");
    } else {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const protocol = "2025-11-25";
  const headers = { "x-api-key": key, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": protocol };
  async function call(method, params, id) {
    const response = await fetch(`${address}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.error, undefined);
    return body.result;
  }
  const initialized = await call("initialize", { protocolVersion: protocol, capabilities: {}, clientInfo: { name: "smoke-test", version: "0" } }, 1);
  assert.equal(initialized.serverInfo.name, "unraidclaw");
  assert.equal(initialized.serverInfo.version, "smoke-test");
  assert.equal(initialized.protocolVersion, protocol);
  console.log("initialize: OK (2025-11-25)");
  const list = await call("tools/list", {}, 2);
  assert(list.tools.some((tool) => tool.name === "unraid_health_check"));
  assert(list.tools.every((tool) => !("server" in tool.inputSchema.properties)));
  console.log(`tools/list: OK (${list.tools.length} tools)`);
  const result = await call("tools/call", { name: "unraid_health_check", arguments: {} }, 3);
  assert.equal(result.isError, false);
  const health = JSON.parse(result.content[0].text);
  assert.equal(health.status, "degraded");
  assert.equal(health.graphqlReachable, false);
  console.log("tools/call unraid_health_check: OK (degraded, closed loopback GraphQL port)");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }
  await rm(directory, { recursive: true, force: true });
  console.log("Smoke-test gateway stopped; temporary files removed.");
}
