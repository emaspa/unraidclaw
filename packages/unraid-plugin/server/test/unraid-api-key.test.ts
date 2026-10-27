import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../src/config.js";

const flash = await mkdtemp(join(tmpdir(), "unraidclaw-unraid-key-test-"));
process.env.FLASH_BASE = flash;
const { loadConfig, loadPermissions } = await import("../src/config.js");
const { hashApiKey } = await import("../src/auth.js");
const { createServer } = await import("../src/server.js");
const { MCP_PROTOCOL_VERSION } = await import("../src/routes/mcp.js");

// Ephemeral material stays in memory and is never printed or saved to fixtures.
const key = randomBytes(32).toString("hex");
const unraidKey = randomBytes(32).toString("hex");
const config: ServerConfig = {
  ...loadConfig(), mcpEnabled: true, port: 9876, host: "127.0.0.1",
  apiKeyHash: hashApiKey(key), graphqlUrl: "http://127.0.0.1:1/graphql", unraidApiKey: "",
};
const headers = { "x-api-key": key };
await writeFile(join(flash, "permissions.json"), JSON.stringify({ "me:read": true }));
loadPermissions();

// Each test sets the GraphQL answer; a test that expects no request leaves it null.
let answer: unknown = null;
const requests: Array<Record<string, string>> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string, init: RequestInit) => {
  requests.push(init.headers as Record<string, string>);
  if (answer === null) throw new Error("No GraphQL request was expected");
  return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
after(async () => { globalThis.fetch = originalFetch; await rm(flash, { recursive: true, force: true }); });

function harness(t: { after(fn: () => Promise<void>): void }, unraidApiKey: string) {
  requests.length = 0;
  answer = null;
  const app = createServer({ ...config, unraidApiKey });
  app.log.level = "silent";
  t.after(() => app.close());
  return app;
}

// unraid-api 4.37 answers HTTP 200 with these bodies, seen on Unraid 7.3.
function unauthenticated(message: string) {
  return {
    errors: [{ message, path: ["me"], extensions: { code: "UNAUTHENTICATED", originalError: { message, error: "Unauthorized", statusCode: 401 } } }],
    data: null,
  };
}

test("a missing Unraid API key fails before any GraphQL request and says where to set it", async (t) => {
  const app = harness(t, "");
  const res = await app.inject({ url: "/api/users/me", headers });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, "UNRAID_API_KEY_MISSING");
  assert.match(res.json().error.message, /Unraid API key is not configured/);
  assert.match(res.json().error.message, /Settings > UnraidClaw/);
  assert.doesNotMatch(res.json().error.message, /CSRF/);
  assert.equal(requests.length, 0);
});

test("an MCP tool call reports the missing Unraid API key instead of a CSRF error", async (t) => {
  const app = harness(t, "");
  const res = await app.inject({
    method: "POST", url: "/mcp",
    headers: { ...headers, "mcp-protocol-version": MCP_PROTOCOL_VERSION },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "unraid_user_me" } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().result.isError, true);
  assert.match(res.json().result.content[0].text, /UNRAID_API_KEY_MISSING: The Unraid API key is not configured/);
  assert.equal(requests.length, 0);
});

test("health reports a missing Unraid API key as degraded with what to fix", async (t) => {
  const app = harness(t, "");
  const res = await app.inject({ url: "/api/health" });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.status, "degraded");
  assert.equal(data.graphqlReachable, false);
  assert.equal(data.unraidApiKeyConfigured, false);
  assert.match(data.message, /Unraid API key is not configured/);
  assert.equal(requests.length, 0);
});

test("health with a working key is ok and carries no message", async (t) => {
  const app = harness(t, unraidKey);
  answer = { data: { me: { name: "root" } } };
  const data = (await app.inject({ url: "/api/health" })).json().data;
  assert.equal(data.status, "ok");
  assert.equal(data.graphqlReachable, true);
  assert.equal(data.unraidApiKeyConfigured, true);
  assert.equal(data.message, undefined);
  assert.equal(requests[0]["x-api-key"], unraidKey);
});

test("health reports a key Unraid refuses as degraded, quoting Unraid", async (t) => {
  const app = harness(t, unraidKey);
  answer = unauthenticated("API key validation failed");
  const data = (await app.inject({ url: "/api/health" })).json().data;
  assert.equal(data.status, "degraded");
  assert.equal(data.graphqlReachable, true);
  assert.equal(data.unraidApiKeyConfigured, true);
  assert.match(data.message, /rejected the Unraid API key \(API key validation failed\)/);
});

for (const message of ["API key validation failed", "Invalid CSRF token"]) {
  test(`an unauthenticated answer (${message}) is reported as a rejected Unraid API key`, async (t) => {
    const app = harness(t, unraidKey);
    answer = unauthenticated(message);
    const res = await app.inject({ url: "/api/users/me", headers });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error.code, "UNRAID_API_KEY_REJECTED");
    assert.match(res.json().error.message, /rejected the Unraid API key/);
    assert(res.json().error.message.includes(message));
    assert(!res.body.includes(unraidKey));
  });
}

test("other GraphQL errors keep the GRAPHQL_ERROR code and status", async (t) => {
  const app = harness(t, unraidKey);
  answer = { errors: [{ message: "Cannot query field", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }], data: null };
  const res = await app.inject({ url: "/api/users/me", headers });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json().error, { code: "GRAPHQL_ERROR", message: "Cannot query field" });
});
