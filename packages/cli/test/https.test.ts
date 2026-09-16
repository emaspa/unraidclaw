import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { X509Certificate } from "node:crypto";
import { capture, fixture, randomKey } from "./helpers.js";
import { remoteConfigPath } from "../src/config.js";

test("CLI with the real gateway over loopback HTTPS", async t => {
  const { dir, context } = await fixture(t);
  const exec = promisify(execFile);
  try { await exec("openssl", ["version"]); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { t.skip("OpenSSL is unavailable"); return; }
    throw new Error("Cannot run OpenSSL");
  }
  const certPath = join(dir, "cert.pem"), privatePath = join(dir, "key.pem");
  try {
    await exec("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-nodes", "-days", "1", "-subj", "/CN=cli-fixture", "-addext", "subjectAltName=IP:127.0.0.1",
      "-keyout", privatePath, "-out", certPath]);
  } catch { throw new Error("Cannot generate the temporary TLS certificate"); }
  // Set before importing the gateway so no module resolves a real flash path.
  const previousFlash = process.env.FLASH_BASE;
  process.env.FLASH_BASE = dir;
  t.after(() => { if (previousFlash === undefined) delete process.env.FLASH_BASE; else process.env.FLASH_BASE = previousFlash; });
  const { loadConfig, loadPermissions } = await import("../../unraid-plugin/server/src/config.js");
  const { createServer } = await import("../../unraid-plugin/server/src/server.js");
  const { hashApiKey } = await import("../../unraid-plugin/server/src/auth.js");
  const key = randomKey(), wrongKey = randomKey();
  const config = { ...loadConfig(), apiKeyHash: hashApiKey(key), unraidApiKey: "", mcpEnabled: false,
    graphqlUrl: "http://127.0.0.1:1/graphql", logFile: join(dir, "activity.jsonl") };
  await writeFile(join(dir, "permissions.json"), JSON.stringify({ "services:read": true }));
  loadPermissions();
  const originalFetch = globalThis.fetch;
  let echoError = false;
  globalThis.fetch = async () => new Response(JSON.stringify(echoError
    ? { errors: [{ message: key }] }
    : { data: { services: [{ name: "fixture", id: "fixture", online: true }] } }), { status: 200 });
  t.after(() => { globalThis.fetch = originalFetch; });
  const certificate = await readFile(certPath);
  const app = createServer(config, { cert: certificate, key: await readFile(privatePath) });
  app.log.level = "silent";
  t.after(() => app.close());
  try { await app.listen({ host: "127.0.0.1", port: 0 }); }
  catch (error) {
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("Sandbox forbids binding loopback sockets; HTTPS and trust require a local listener"); return;
    }
    throw error;
  }
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const url = `https://127.0.0.1:${address.port}`;
  context.env.UNRAIDCLAW_URL = url;
  context.env.UNRAIDCLAW_KEY = key;
  const cli = capture(context);
  const configPath = remoteConfigPath(context);

  await t.test("an authenticated read verifies the self-signed certificate with --ca-cert", async () => {
    const result = await cli.run(["service", "list", "--ca-cert", certPath, "--output", "json"]);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), [{ name: "fixture", id: "fixture", online: true }]);
    assert.equal(result.stderr, "");
  });
  await t.test("permission denial preserves gateway code and message with exit 4", async () => {
    // The permission pre-handler refuses this before any host operation.
    const result = await cli.run(["docker", "remove", "fixture", "--yes", "--ca-cert", certPath]);
    assert.equal(result.code, 4);
    assert.match(result.stderr, /FORBIDDEN: Permission denied: docker:delete/);
    assert.equal(result.stdout, "");
  });
  await t.test("wrong key exits 3 without disclosing either credential", async () => {
    const result = await cli.run(["service", "list", "--ca-cert", certPath, "--key", wrongKey]);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /UNAUTHORIZED/);
    assert.ok(![key, wrongKey].some(secret => (result.stdout + result.stderr).includes(secret)));
  });
  await t.test("TLS fails closed without trust and --insecure explicitly bypasses verification", async () => {
    const failed = await cli.run(["service", "list"]);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /certificate is not trusted.*unraidclaw trust.*--ca-cert <path>.*caCert/);
    assert.ok(!(failed.stdout + failed.stderr).includes(key));
    const bypassed = await cli.run(["service", "list", "--insecure"]);
    assert.equal(bypassed.code, 0);
    assert.match(bypassed.stderr, /verification is disabled/);
    const alias = await cli.run(["service", "list", "--tls-skip"]);
    assert.equal(alias.code, 0);
  });
  await t.test("a trusted certificate still refuses a URL host missing from its alternative names", async () => {
    const result = await cli.run(["service", "list", "--url", `https://localhost:${address.port}`, "--ca-cert", certPath]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /localhost.*not listed.*address the certificate lists.*regenerate.*Settings/);
    assert.ok(!result.stderr.includes(key));
  });
  await t.test("HTTP against the HTTPS port suggests checking the URL protocol", async () => {
    const result = await cli.run(["health", "--url", `http://127.0.0.1:${address.port}`]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Check http vs https/);
    assert.ok(!(result.stdout + result.stderr).includes(key));
  });
  await t.test("API messages that echo credentials are redacted", async () => {
    echoError = true;
    try {
      const result = await cli.run(["service", "list", "--ca-cert", certPath]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /GRAPHQL_ERROR: \[redacted\]/);
      assert.ok(!(result.stdout + result.stderr).includes(key));
    } finally { echoError = false; }
  });
  await t.test("trust refuses unattended acceptance and interactive cancellation without writing", async () => {
    const refused = await cli.run(["trust"]);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /fingerprint/);
    cli.io.interactive = true;
    cli.io.confirm = async () => false;
    try { assert.equal((await cli.run(["trust"])).code, 1); }
    finally { cli.io.interactive = false; }
    await assert.rejects(stat(configPath), { code: "ENOENT" });
  });
  await t.test("trust saves the displayed certificate and subsequent requests verify normally", async () => {
    const accepted = await cli.run(["trust", "--yes", "--output", "json"]);
    assert.equal(accepted.code, 0);
    assert.match(accepted.stderr, /WebGUI/);
    const details = JSON.parse(accepted.stdout);
    assert.equal(details.fingerprint, new X509Certificate(certificate).fingerprint256);
    assert.equal(details.subjectAltName, "IP Address:127.0.0.1");
    assert.equal(details.caCert, join(dirname(configPath), `127.0.0.1-${address.port}.pem`));
    assert.equal(await readFile(details.caCert, "utf8"), certificate.toString());
    if (process.platform !== "win32") assert.equal((await stat(details.caCert)).mode & 0o777, 0o600);
    const stored = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(stored.caCert, details.caCert);
    assert.equal(stored.insecure, false);
    assert.equal((await cli.run(["service", "list"])).code, 0);
    assert.equal((await cli.run(["health"])).code, 0);
  });
  await t.test("table trust shows certificate details once and reports only saved settings on stdout", async () => {
    const result = await cli.run(["trust", "--yes"]);
    assert.equal(result.code, 0);
    const caCert = join(dirname(configPath), `127.0.0.1-${address.port}.pem`);
    assert.equal(result.stdout, `url: ${url}\ncaCert: ${caCert}\ninsecure: false\n`);
    for (const field of ["subject", "subjectAltName", "expiry", "fingerprint"]) {
      assert.equal(result.stderr.split(`${field}:`).length, 2);
      assert.ok(!result.stdout.includes(`${field}:`));
    }
    assert.ok(result.stderr.includes(new X509Certificate(certificate).fingerprint256));
  });
  const activity = await readFile(config.logFile, "utf8");
  assert.ok(![key, wrongKey].some(secret => activity.includes(secret)), "activity log must not contain credentials");
  await app.close();
  await t.test("a closed loopback port reports connection refusal for requests and trust", async () => {
    for (const argv of [["service", "list"], ["trust", "--yes"]]) {
      const result = await cli.run(argv);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.includes(`Nothing is listening at ${url}`));
      assert.match(result.stderr, /Check the port.*UnraidClaw service is running/);
      assert.ok(!result.stderr.includes(key));
    }
  });
});
