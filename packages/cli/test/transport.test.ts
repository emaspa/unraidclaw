import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../src/errors.js";
import { connectionError, HttpClient, peerCertificate } from "../src/transport.js";
import { capture, fixture, randomKey } from "./helpers.js";

test("HTTP client sends the registry request, applies per-request TLS and maps API failures offline", async t => {
  const { dir, context } = await fixture(t);
  const key = randomKey();
  const caCert = join(dir, "ca.pem");
  await writeFile(caCert, "fixture public certificate");
  let status = 200;
  let data: unknown = { ok: true, data: { state: "running" } };
  let options: https.RequestOptions = {};
  let requested = "";
  let sent: string | undefined;
  let calls = 0;
  // Only replace the network boundary. The registry, parser and output still run.
  t.mock.method(https, "request", (url: URL, opts: https.RequestOptions, callback: (response: EventEmitter & { statusCode: number }) => void) => {
    calls++;
    options = opts;
    requested = url.href;
    const request = new EventEmitter() as EventEmitter & { end(value?: string): void; destroy(): void };
    request.destroy = () => { request.emit("close"); };
    request.end = payload => {
      sent = payload;
      const response = Object.assign(new EventEmitter(), { statusCode: status });
      callback(response);
      response.emit("data", Buffer.from(typeof data === "string" ? data : JSON.stringify(data)));
      response.emit("end");
      request.emit("close");
    };
    return request;
  });
  context.env.UNRAIDCLAW_URL = "https://127.0.0.1:9876";
  context.env.UNRAIDCLAW_KEY = key;
  const cli = capture(context);
  const read = await cli.run(["docker", "inspect", "fixture", "--ca-cert", caCert, "--output", "json"]);
  assert.equal(read.code, 0);
  assert.deepEqual(JSON.parse(read.stdout), { state: "running" });
  assert.equal(requested, "https://127.0.0.1:9876/api/docker/containers/fixture");
  assert.equal(options.rejectUnauthorized, true);
  assert.ok(Buffer.isBuffer(options.ca) && options.ca.toString() === "fixture public certificate");
  assert.ok((options.headers as Record<string, string>)["x-api-key"] === key);
  assert.equal((await cli.run(["ca", "install", "fixture", "--dry-run", "--yes", "--insecure"])).code, 0);
  assert.equal(options.rejectUnauthorized, false);
  assert.equal(options.ca, undefined);
  assert.deepEqual(JSON.parse(sent!), { dryRun: true });
  for (const [http, expected, code] of [[401, 3, "UNAUTHORIZED"], [403, 4, "FORBIDDEN"], [500, 1, "INTERNAL_ERROR"]] as const) {
    status = http;
    data = { ok: false, error: { code, message: key } };
    const result = await cli.run(["docker", "list"]);
    assert.equal(result.code, expected);
    assert.ok(result.stderr.includes(`${code}: [redacted]`));
    assert.ok(!(result.stdout + result.stderr).includes(key));
  }
  status = 401;
  data = "invalid response";
  assert.equal((await cli.run(["docker", "list"])).code, 3);
  status = 302;
  data = { ok: true, data: {} };
  assert.match((await cli.run(["docker", "list"])).stderr, /Redirects are not followed/);
  const client = new HttpClient({ url: context.env.UNRAIDCLAW_URL, key });
  const before = calls;
  await assert.rejects(client.get("https://outside.invalid/api/test"), CliError);
  assert.equal(calls, before);
  delete context.env.UNRAIDCLAW_KEY;
  const missing = await cli.run(["docker", "list"]);
  assert.equal(missing.code, 2);
  assert.equal(calls, before);
});

test("connection error codes give distinct actionable messages without reflecting error secrets", () => {
  const url = new URL("https://fixture.invalid:9876");
  const key = randomKey();
  const cases: [string, RegExp][] = [
    ...["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_UNTRUSTED"]
      .map(code => [code, /certificate is not trusted.*unraidclaw trust.*--ca-cert <path>.*caCert matches the server.*regenerated certificate needs trusting again/] as [string, RegExp]),
    ["ERR_TLS_CERT_ALTNAME_INVALID", /fixture\.invalid.*not listed.*address the certificate lists.*regenerate.*Settings/],
    ["CERT_HAS_EXPIRED", /certificate has expired/], ["CERT_NOT_YET_VALID", /certificate is not yet valid/],
    ["ECONNREFUSED", /Nothing is listening at https:\/\/fixture\.invalid:9876.*port.*service is running/],
    ["ENOTFOUND", /Cannot resolve the host fixture\.invalid/], ["EAI_AGAIN", /Cannot resolve the host fixture\.invalid/],
    ...["EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"].map(code => [code, /fixture\.invalid.*unreachable or.*timed out/] as [string, RegExp]),
    ["ECONNRESET", /Check http vs https/], ["EPROTO", /Check http vs https/],
    ["ERR_UNKNOWN_FIXTURE", /Connection failed \(ERR_UNKNOWN_FIXTURE\)/],
  ];
  for (const [code, expected] of cases) {
    const result = connectionError(Object.assign(new Error(key), { code }), url);
    assert.equal(result.exitCode, 1);
    assert.match(result.message, expected);
    assert.ok(!result.message.includes(key));
  }
  assert.match(connectionError(new Error(`TLS wrong version number ${key}`), url).message, /Check http vs https/);
  for (const error of [undefined, null, new Error(key), { code: key }]) {
    const result = connectionError(error, url);
    assert.match(result.message, /Connection failed/);
    assert.ok(!result.message.includes(key));
  }
});

test("HTTP requests and certificate retrieval share connection error mapping", async t => {
  const { context } = await fixture(t);
  const key = randomKey();
  context.env.UNRAIDCLAW_KEY = key;
  let failure: Error;
  function boundary() {
    const socket = new EventEmitter();
    const fail = () => { socket.emit("error", failure); socket.emit("close"); };
    queueMicrotask(fail);
    return Object.assign(socket, { end() {}, destroy() {} });
  }
  t.mock.method(http, "request", boundary);
  t.mock.method(https, "request", boundary);
  t.mock.method(tls, "connect", boundary);
  for (const protocol of ["http:", "https:"]) {
    const url = new URL(`${protocol}//fixture.invalid:9876`);
    for (const code of ["ECONNREFUSED", "EPROTO", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"]) {
      failure = Object.assign(new Error(key), { code });
      const expected = connectionError(failure, url).message;
      const result = await capture(context).run(["health", "--url", url.origin]);
      assert.equal(result.code, 1);
      assert.equal(result.stderr, expected + "\n");
      assert.ok(!(result.stdout + result.stderr).includes(key));
      if (protocol === "https:") await assert.rejects(peerCertificate(url), { message: expected });
    }
  }
});

test("the 30 second request and trust deadlines use the timeout diagnostic", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  function boundary() {
    const socket = new EventEmitter();
    return Object.assign(socket, {
      end() {},
      destroy(error: Error) { socket.emit("error", error); socket.emit("close"); },
    });
  }
  t.mock.method(https, "request", boundary);
  t.mock.method(tls, "connect", boundary);
  const url = new URL("https://fixture.invalid:9876");
  for (const start of [() => new HttpClient({ url: url.origin }).get("/api/health"), () => peerCertificate(url)]) {
    const check = assert.rejects(start(), /fixture\.invalid.*unreachable or.*timed out/);
    t.mock.timers.tick(30_000);
    await check;
  }
});
