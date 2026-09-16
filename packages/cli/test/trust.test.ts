import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { remoteConfigPath } from "../src/config.js";
import { capture, fixture } from "./helpers.js";

test("trust reports saved settings in table mode and retains certificate details in JSON offline", async t => {
  const { dir, context } = await fixture(t);
  const certPath = join(dir, "cert.pem");
  try {
    await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-nodes", "-days", "1", "-subj", "/CN=cli-fixture", "-addext", "subjectAltName=IP:127.0.0.1",
      "-keyout", join(dir, "key.pem"), "-out", certPath]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { t.skip("OpenSSL is unavailable"); return; }
    throw new Error("Cannot generate the temporary TLS certificate");
  }
  const certificate = new X509Certificate(await readFile(certPath));
  // Mock only the TLS boundary; certificate parsing, confirmation and saving run normally.
  t.mock.method(tls, "connect", (options: tls.ConnectionOptions) => {
    assert.equal(options.rejectUnauthorized, false);
    const socket = Object.assign(new EventEmitter(), {
      getPeerCertificate: () => ({ raw: certificate.raw }),
      destroy() { socket.emit("close"); },
    });
    queueMicrotask(() => socket.emit("secureConnect"));
    return socket;
  });
  const url = "https://127.0.0.1:9876";
  context.env.UNRAIDCLAW_URL = url;
  const cli = capture(context);
  cli.io.interactive = true;
  const caCert = join(dirname(remoteConfigPath(context)), "127.0.0.1-9876.pem");
  for (const flags of [[], ["--output", "table"], ["--output", "json"]]) {
    const result = await cli.run(["trust", ...flags]);
    assert.equal(result.code, 0);
    assert.equal(result.confirmations, 1);
    for (const field of ["subject", "subjectAltName", "expiry", "fingerprint"]) {
      assert.equal(result.stderr.split(`${field}:`).length, 2);
    }
    assert.ok(result.stderr.indexOf(certificate.fingerprint256) < result.stderr.indexOf("Trust this certificate?"));
    if (flags.includes("json")) {
      assert.equal(result.stdout, JSON.stringify({ subject: certificate.subject, subjectAltName: certificate.subjectAltName,
        expiry: certificate.validTo, fingerprint: certificate.fingerprint256, caCert, url, insecure: false }, null, 2) + "\n");
    } else {
      assert.equal(result.stdout, `url: ${url}\ncaCert: ${caCert}\ninsecure: false\n`);
    }
    assert.equal(await readFile(caCert, "utf8"), certificate.toString());
    assert.deepEqual(JSON.parse(await readFile(remoteConfigPath(context), "utf8")), { url, caCert, insecure: false });
  }
});
