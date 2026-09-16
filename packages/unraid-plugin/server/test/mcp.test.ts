import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../src/config.js";

const flash = await mkdtemp(join(tmpdir(), "unraidclaw-mcp-test-"));
process.env.FLASH_BASE = flash;
const { loadConfig, loadPermissions } = await import("../src/config.js");
const { hashApiKey } = await import("../src/auth.js");
const { createServer } = await import("../src/server.js");
const { registerTools, isErrorResult } = await import("unraidclaw/tools");
const { MCP_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } = await import("../src/routes/mcp.js");
const { READ_ONLY } = await import("../src/mcp-tools.js");
const { mcpOrigins, validMcpOrigin } = await import("../src/mcp-security.js");

// Ephemeral material stays in memory and is never printed or saved to fixtures.
const key = randomBytes(32).toString("hex");
const config: ServerConfig = {
  ...loadConfig(), mcpEnabled: true, port: 9876, host: "127.0.0.1",
  apiKeyHash: hashApiKey(key), graphqlUrl: "http://127.0.0.1:1/graphql",
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Network is forbidden in MCP tests"); };
after(async () => { globalThis.fetch = originalFetch; await rm(flash, { recursive: true, force: true }); });
beforeEach(async () => {
  await writeFile(join(flash, "permissions.json"), "{}");
  loadPermissions();
});

async function permissions(matrix: Record<string, boolean>) {
  await writeFile(join(flash, "permissions.json"), JSON.stringify(matrix));
  loadPermissions();
}

function harness(t: { after(fn: () => Promise<void>): void }, mcpEnabled = true) {
  const app = createServer({ ...config, mcpEnabled });
  app.log.level = "silent";
  t.after(() => app.close());
  return app;
}

function rpc(method: string, params?: unknown, id: string | number = 1) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}
const headers = { "x-api-key": key, "mcp-protocol-version": MCP_PROTOCOL_VERSION };
const init = { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "0" } };

for (const enabled of [false, true]) {
  test(`REST authentication, permissions and parser remain unchanged with MCP ${enabled}`, async (t) => {
    const app = harness(t, enabled);
    assert.equal((await app.inject({ url: "/api/health" })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/users/me" })).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/users/me", headers: { authorization: `Bearer ${key}` } })).statusCode, 401);
    const denied = await app.inject({ url: "/api/users/me", headers });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, "FORBIDDEN");
    const malformed = await app.inject({ method: "POST", url: "/api/ca/app/test/install", headers: { ...headers, "content-type": "application/json" }, payload: "{" });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().ok, false);
    assert.equal(malformed.json().jsonrpc, undefined);
  });
}

test("disabled MCP has no route, including unauthenticated requests and preflights", async (t) => {
  const app = harness(t, false);
  for (const method of ["POST", "GET", "DELETE", "OPTIONS"] as const) {
    for (const auth of [{}, headers]) {
      for (const url of ["/mcp", "/%6dcp"]) {
        const res = await app.inject({ method, url, headers: auth });
        assert.equal(res.statusCode, 404);
      }
    }
  }
});

test("MCP accepts either key header, refuses missing or invalid keys, and shares the IP limiter", async (t) => {
  const app = harness(t);
  for (const auth of [{ "x-api-key": key }, { authorization: `Bearer ${key}` }]) {
    const res = await app.inject({ method: "POST", url: "/mcp", headers: { ...auth, "mcp-protocol-version": MCP_PROTOCOL_VERSION }, payload: rpc("ping") });
    assert.equal(res.statusCode, 200);
  }
  for (const auth of [{}, { "x-api-key": randomBytes(32).toString("hex") }, { authorization: "Basic invalid" }]) {
    assert.equal((await app.inject({ method: "POST", url: "/mcp", headers: auth, payload: rpc("ping"), remoteAddress: "127.0.0.2" })).statusCode, 401);
  }
  for (let i = 0; i < 10; i++) {
    const res = await app.inject({ method: "POST", url: "/mcp", payload: rpc("ping"), remoteAddress: "127.0.0.3" });
    assert.equal(res.statusCode, 401);
  }
  for (const url of ["/mcp", "/api/users/me"]) {
    assert.equal((await app.inject({ url, headers, remoteAddress: "127.0.0.3" })).statusCode, 429);
  }
});

test("Origin checks resist rebinding, apply to preflights, and permit trusted exact origins", async (t) => {
  const app = harness(t);
  for (const origin of ["https://attacker.example", "http://localhost:9877", "null", "http://localhost:9876/", "http://192.168.attacker.example:9876"]) {
    for (const method of ["POST", "GET", "DELETE", "OPTIONS"] as const) {
      const res = await app.inject({ method, url: "/mcp", headers: { ...headers, origin, host: new URL(origin === "null" ? "http://attacker.example" : origin).host }, ...(method === "POST" ? { payload: rpc("ping") } : {}) });
      assert.equal(res.statusCode, 403);
      assert.equal(res.headers["access-control-allow-origin"], undefined);
    }
  }
  const origin = "http://localhost:9876";
  const preflight = await app.inject({ method: "OPTIONS", url: "/mcp", headers: { origin } });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], origin);
  assert.match(String(preflight.headers["access-control-allow-headers"]), /Authorization.*MCP-Protocol-Version/);
  assert.equal((await app.inject({ method: "POST", url: "/mcp", headers: { ...headers, origin }, payload: rpc("ping") })).statusCode, 200);
  for (const url of ["/%6dcp", "/m%63p", "/mcp/", "//mcp"]) {
    const res = await app.inject({ method: "POST", url, headers: { ...headers, origin: "http://attacker.example:9876" }, payload: rpc("ping") });
    assert([403, 404].includes(res.statusCode), `Unexpected status ${res.statusCode} for ${url}`);
  }
  assert(validMcpOrigin("https://localhost:9876", mcpOrigins(config, true)));
  assert(!validMcpOrigin("http://localhost:9876", mcpOrigins(config, true)));
  const interfaces = () => ({ test: [{ address: "127.0.0.8", family: "IPv4" as const, netmask: "255.0.0.0", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.8/8" }] });
  assert(validMcpOrigin("http://127.0.0.8:9876", mcpOrigins(config, false, interfaces)));
  const restricted = mcpOrigins(config, false, () => { throw new Error("Interface access denied"); });
  assert(validMcpOrigin("http://127.0.0.1:9876", restricted));
  assert(!validMcpOrigin("http://127.0.0.8:9876", restricted));
});

test("initialize negotiates the supported version and returns no session", async (t) => {
  const app = harness(t);
  process.env.OCC_VERSION = "test-build";
  t.after(async () => { delete process.env.OCC_VERSION; });
  assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, ["2025-11-25", "2025-06-18", "2025-03-26"]);
  assert.equal(MCP_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS[0]);
  for (const version of [...SUPPORTED_PROTOCOL_VERSIONS, "future-version"]) {
    const res = await app.inject({ method: "POST", url: "/mcp", headers: { "x-api-key": key }, payload: rpc("initialize", { ...init, protocolVersion: version }, "init") });
    assert.equal(res.statusCode, 200);
    const expectedVersion = version === "future-version" ? MCP_PROTOCOL_VERSION : version;
    assert.deepEqual(res.json(), { jsonrpc: "2.0", id: "init", result: { protocolVersion: expectedVersion, capabilities: { tools: {} }, serverInfo: { name: "unraidclaw", version: "test-build" } } });
    assert.equal(res.headers["mcp-session-id"], undefined);
    assert.match(String(res.headers["content-type"]), /application\/json/);
  }
});

test("MCP accepts supported or absent version headers and rejects unsupported versions and batches", async (t) => {
  const app = harness(t);
  for (const version of [...SUPPORTED_PROTOCOL_VERSIONS, undefined]) {
    const auth = { "x-api-key": key, ...(version === undefined ? {} : { "mcp-protocol-version": version }) };
    const res = await app.inject({ method: "POST", url: "/mcp", headers: auth, payload: rpc("ping") });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { jsonrpc: "2.0", id: 1, result: {} });
    for (const payload of [[], [rpc("ping")]]) {
      const batch = await app.inject({ method: "POST", url: "/mcp", headers: auth, payload });
      assert.equal(batch.statusCode, 400);
      assert.equal(batch.json().error.code, -32600);
    }
  }
  for (const payload of [rpc("initialize", init), rpc("ping"), { jsonrpc: "2.0", method: "notifications/initialized" }]) {
    const res = await app.inject({ method: "POST", url: "/mcp", headers: { ...headers, "mcp-protocol-version": "unsupported" }, payload });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, -32600);
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) assert(res.json().error.message.includes(version));
  }
});

test("tools/list reuses every OpenClaw definition, removes server, and annotates mutations", async (t) => {
  const app = harness(t);
  const res = await app.inject({ method: "POST", url: "/mcp", headers, payload: rpc("tools/list") });
  const tools = res.json().result.tools;
  const registrations: any[] = [];
  registerTools({ registerTool: (tool, options) => registrations.push({ tool, options }) }, () => { throw new Error("Discovery must not request a client"); });
  assert.equal(tools.length, registrations.length);
  assert.equal(tools.length, 55);
  const registeredNames = new Set(registrations.map(({ tool }) => tool.name));
  for (const name of READ_ONLY) assert(registeredNames.has(name), `Read-only tool ${name} must be registered`);
  for (const { tool, options } of registrations) {
    const entry = tools.find((item: any) => item.name === tool.name);
    assert(entry);
    assert.equal(entry.description, tool.description);
    assert.equal(entry.inputSchema.properties.server, undefined);
    assert(!entry.inputSchema.required.includes("server"));
    assert.equal(entry.inputSchema.additionalProperties, false);
    assert.equal(typeof entry.annotations.readOnlyHint, "boolean");
    if (options?.optional) assert.deepEqual(entry.annotations, { readOnlyHint: false, destructiveHint: true });
    assert(tool.parameters.properties?.server, "OpenClaw schema must remain unchanged");
  }
  for (const name of ["unraid_docker_stop", "unraid_system_reboot", "unraid_docker_remove"]) {
    assert.deepEqual(tools.find((item: any) => item.name === name).annotations, { readOnlyHint: false, destructiveHint: true });
  }
  for (const name of ["unraid_health_check", "unraid_vm_inspect"]) {
    assert.deepEqual(tools.find((item: any) => item.name === name).annotations, { readOnlyHint: true, destructiveHint: false });
  }
});

test("read calls reach real REST routes, preserve data, hot-reload permissions and log the original IP", async (t) => {
  const app = harness(t);
  const { GraphQLClient } = await import("../src/graphql-client.js");
  const me = { name: "fixture-user", description: "fixture", roles: [] };
  t.mock.method(GraphQLClient.prototype, "query", async () => ({ me }));
  await permissions({ "me:read": true });
  const request = { method: "POST" as const, url: "/mcp", headers: { authorization: `Bearer ${key}`, "mcp-protocol-version": MCP_PROTOCOL_VERSION }, payload: rpc("tools/call", { name: "unraid_user_me" }), remoteAddress: "127.0.0.4" };
  const res = await app.inject(request);
  assert.equal(res.json().result.isError, false);
  assert.deepEqual(JSON.parse(res.json().result.content[0].text), me);
  await permissions({});
  const denied = await app.inject(request);
  assert.equal(denied.statusCode, 200);
  assert.equal(denied.json().result.isError, true);
  assert.match(denied.json().result.content[0].text, /FORBIDDEN: Permission denied: me:read/);
  const logs = await readFile(config.logFile, "utf8");
  assert(!logs.includes(key));
  const entries = logs.trim().split("\n").map((line) => JSON.parse(line));
  assert(entries.some((entry) => entry.path === "/api/users/me" && entry.ip === "127.0.0.4" && entry.statusCode === 403));
  const calls = entries.filter((entry) => entry.path === "/mcp" && entry.ip === "127.0.0.4");
  assert.deepEqual(calls.map(({ tool, resource, action, statusCode }) => ({ tool, resource, action, statusCode })), [
    { tool: "unraid_user_me", resource: "users", action: "read", statusCode: 200 },
    { tool: "unraid_user_me", resource: "users", action: "read", statusCode: 403 },
  ]);
});

test("MCP log entries name the method or tool, never client-supplied names, and skip a successful handshake", async (t) => {
  const app = harness(t);
  const ip = "127.0.0.5";
  const send = (payload: unknown, extra: Record<string, string> = {}) => app.inject({ method: "POST", url: "/mcp", headers: { ...headers, ...extra }, payload: payload as object, remoteAddress: ip });
  await send(rpc("initialize", init));
  await send(rpc("tools/list"));
  await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await send(rpc("ping"));
  await app.inject({ method: "GET", url: "/mcp", headers, remoteAddress: ip });
  await app.inject({ method: "DELETE", url: "/mcp", headers, remoteAddress: ip });
  await send(rpc("ping"), { "mcp-protocol-version": "1999-01-01" });
  await app.inject({ method: "POST", url: "/mcp", payload: rpc("initialize", init), remoteAddress: ip });
  await send(rpc("made/up-method-name"));
  await send(rpc("tools/call", { name: "unraid_made_up_tool" }));
  await send(rpc("tools/call", { name: "unraid_health_check", arguments: { unexpected: true } }));
  await app.inject({ method: "POST", url: "/mcp", headers: { ...headers, "content-type": "application/json" }, payload: "{", remoteAddress: ip });
  const entries = (await readFile(config.logFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    .filter((entry) => entry.ip === ip);
  assert.deepEqual(entries.map(({ tool, resource, action, statusCode }) => ({ tool, resource, action, statusCode })), [
    { tool: undefined, resource: "mcp", action: "ping", statusCode: 400 },
    { tool: undefined, resource: "mcp", action: "rejected", statusCode: 401 },
    { tool: undefined, resource: "mcp", action: "invalid", statusCode: 400 },
    { tool: undefined, resource: "mcp", action: "tools/call", statusCode: 400 },
    { tool: "unraid_health_check", resource: "mcp", action: "tools/call", statusCode: 200 },
    { tool: undefined, resource: "mcp", action: "rejected", statusCode: 400 },
  ]);
  assert(!entries.some((entry) => JSON.stringify(entry).includes("made")));
});

test("unauthenticated requests to unknown paths return 404 and do not use up the login limit", async (t) => {
  const app = harness(t);
  const ip = "127.0.0.6";
  const probes = ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration", "/register"];
  for (let round = 0; round < 4; round++) {
    for (const url of probes) {
      assert.equal((await app.inject({ url, remoteAddress: ip })).statusCode, 404);
    }
  }
  const ping = await app.inject({ method: "POST", url: "/mcp", headers, payload: rpc("ping"), remoteAddress: ip });
  assert.equal(ping.statusCode, 200);
  assert.equal((await app.inject({ url: "/api/users/me", remoteAddress: ip })).statusCode, 401);
});

test("invalid tool inputs never inject a REST request or become a mutation", async (t) => {
  const app = harness(t);
  let requests = 0;
  app.addHook("onRequest", async (request) => { if (request.url.startsWith("/api/")) requests++; });
  for (const [name, args] of [
    ["unraid_ca_install", { name: "fixture", dryrun: true }],
    ["unraid_ca_install", { name: "fixture", dryRun: "true" }],
    ["unraid_ca_install", { name: "fixture", overrides: { field: false } }],
    ["unraid_ca_install", { dryRun: true }],
    ["unraid_ca_install", { name: "fixture", server: "another-host" }],
    ["unraid_docker_stop", { id: "fixture", dryrun: true }],
    ["unraid_docker_create", { image: "fixture", ports: [false] }],
    ["unraid_docker_create", { image: "fixture", restart: "invalid" }],
    ["unraid_health_check", { unexpected: true }],
  ]) {
    const res = await app.inject({ method: "POST", url: "/mcp", headers, payload: rpc("tools/call", { name, arguments: args }) });
    assert.equal(res.json().result.isError, true);
    assert.match(res.json().result.content[0].text, /Nothing was sent/);
  }
  assert.equal(requests, 0);
});

test("JSON-RPC errors, protocol headers, notifications and unsupported methods", async (t) => {
  const app = harness(t);
  for (const [payload, code] of [
    ["{", -32700], ["", -32700], ["null", -32600], ["[]", -32600],
    [JSON.stringify([rpc("ping")]), -32600], [JSON.stringify({ ...rpc("ping"), id: null }), -32600],
    [JSON.stringify({ ...rpc("ping"), jsonrpc: "1.0" }), -32600],
    [JSON.stringify(rpc("missing")), -32601], [JSON.stringify(rpc("initialize", {})), -32602],
    [JSON.stringify(rpc("tools/call", { name: "missing" })), -32602],
    [JSON.stringify(rpc("tools/call", { name: "unraid_health_check", arguments: [] })), -32602],
    [JSON.stringify(rpc("ping", [])), -32602], [JSON.stringify(rpc("tools/list", { cursor: "invalid" })), -32602],
  ] as const) {
    const res = await app.inject({ method: "POST", url: "/mcp", headers: { ...headers, "content-type": "application/json" }, payload });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, code, payload);
  }
  assert.equal((await app.inject({ method: "POST", url: "/mcp", headers: { ...headers, "content-type": "text/plain" }, payload: JSON.stringify(rpc("ping")) })).statusCode, 415);
  assert.equal((await app.inject({ method: "POST", url: "/mcp", headers: { ...headers, accept: "text/event-stream" }, payload: rpc("ping") })).statusCode, 406);
  const oversized = await app.inject({ method: "POST", url: "/mcp", headers: { ...headers, "content-type": "application/json" }, payload: " ".repeat(1024 * 1024 + 1) });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.json().error.code, -32600);
  // Notifications do not execute tools.
  for (const method of ["notifications/initialized", "notifications/cancelled", "notifications/unknown"]) {
    const res = await app.inject({ method: "POST", url: "/mcp", headers, payload: { jsonrpc: "2.0", method } });
    assert.equal(res.statusCode, 202);
    assert.equal(res.body, "");
  }
  const noId = await app.inject({ method: "POST", url: "/mcp", headers, payload: { jsonrpc: "2.0", method: "tools/call", params: { name: "unraid_system_reboot" } } });
  assert.equal(noId.statusCode, 400);
  for (const method of ["GET", "DELETE"] as const) {
    const res = await app.inject({ method, url: "/mcp", headers });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, "POST");
  }
});

test("shared registry preserves OpenClaw failures and multi-server resolution", async () => {
  const tools = new Map<string, any>();
  const selected: unknown[] = [];
  registerTools({ registerTool: (tool) => { tools.set(tool.name, tool); } }, (server) => {
    selected.push(server);
    return { get: async () => { throw new Error("fixture failure"); } } as any;
  });
  const result = await tools.get("unraid_health_check").execute("1", { server: "secondary" });
  assert.deepEqual(selected, ["secondary"]);
  assert.deepEqual(result, { content: [{ type: "text", text: "Error: fixture failure" }] });
  assert(isErrorResult(result));
  const invalid = await tools.get("unraid_ca_install").execute("2", { name: "fixture", dryrun: true });
  assert(isErrorResult(invalid));
  assert.match(invalid.content[0].text, /Did you mean "dryRun"/);
  assert.equal(selected.length, 1);
});
