import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../src/config.js";

const flash = await mkdtemp(join(tmpdir(), "unraidclaw-vms-test-"));
process.env.FLASH_BASE = flash;
const { loadConfig, loadPermissions } = await import("../src/config.js");
const { hashApiKey } = await import("../src/auth.js");
const { createServer } = await import("../src/server.js");

// Ephemeral material stays in memory and is never printed or saved to fixtures.
const key = randomBytes(32).toString("hex");
const config: ServerConfig = {
  ...loadConfig(), port: 9876, host: "127.0.0.1",
  apiKeyHash: hashApiKey(key), graphqlUrl: "http://127.0.0.1:1/graphql", unraidApiKey: randomBytes(32).toString("hex"),
};
const headers = { "x-api-key": key };
await writeFile(join(flash, "permissions.json"), JSON.stringify({ "vms:read": true }));
loadPermissions();

let answer: unknown = null;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  if (answer === null) throw new Error("No GraphQL request was expected");
  return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
after(async () => { globalThis.fetch = originalFetch; await rm(flash, { recursive: true, force: true }); });

function harness(t: { after(fn: () => Promise<void>): void }, body: unknown) {
  answer = body;
  const app = createServer(config);
  app.log.level = "silent";
  t.after(() => app.close());
  return app;
}

// What unraid-api 4.37.11 on Unraid 7.4.0 answers when libvirt is not running,
// seen on a server with the VM Manager disabled.
const vmsUnavailable = {
  errors: [{ message: "Failed to retrieve VM domains: VMs are not available", path: ["vms", "domains"], extensions: { code: "INTERNAL_SERVER_ERROR" } }],
  data: { vms: null },
};

test("a stopped VM service is reported as VMS_UNAVAILABLE, not a GraphQL error", async (t) => {
  const app = harness(t, vmsUnavailable);
  for (const url of ["/api/vms", "/api/vms/my-vm"]) {
    const res = await app.inject({ url, headers });
    assert.equal(res.statusCode, 503, url);
    assert.equal(res.json().error.code, "VMS_UNAVAILABLE");
    assert.match(res.json().error.message, /Settings > VM Manager/);
  }
});

test("a null VM list without an error is an empty list", async (t) => {
  for (const data of [{ vms: null }, { vms: { domains: null } }, { vms: { domains: [] } }]) {
    const app = harness(t, { data });
    const res = await app.inject({ url: "/api/vms", headers });
    assert.equal(res.statusCode, 200, JSON.stringify(data));
    assert.deepEqual(res.json(), { ok: true, data: [] });
    assert.equal((await app.inject({ url: "/api/vms/my-vm", headers })).statusCode, 404);
  }
});

test("VMs are listed with their uuid, and other GraphQL errors keep their code", async (t) => {
  const uuid = "12345678-1234-1234-1234-123456789abc";
  const app = harness(t, { data: { vms: { domains: [{ id: `server:${uuid}`, name: "my-vm", state: "RUNNING" }] } } });
  assert.deepEqual((await app.inject({ url: "/api/vms", headers })).json().data, [{ id: `server:${uuid}`, name: "my-vm", state: "RUNNING", uuid }]);
  assert.equal((await app.inject({ url: "/api/vms/my-vm", headers })).json().data.uuid, uuid);

  answer = { errors: [{ message: "Failed to retrieve VM domains: something else" }], data: { vms: null } };
  const res = await app.inject({ url: "/api/vms", headers });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "GRAPHQL_ERROR");
});
