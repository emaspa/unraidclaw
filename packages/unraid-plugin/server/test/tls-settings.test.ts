import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const base = new URL("../../src/usr/local/emhttp/plugins/unraidclaw/", import.meta.url);
const script = await readFile(new URL("javascript/unraidclaw.js", base), "utf8");
const page = await readFile(new URL("unraidclaw.page", base), "utf8");

function fixture(confirmed = true) {
  const elements = new Map(Array.from(page.matchAll(/id="(occ-cert-[^"]+|occ-regenerate-cert-btn)"/g), match => [match[1], {
    textContent: "previous details", disabled: false, style: { display: "none", color: "" },
    set innerHTML(_value: string) { assert.fail("Certificate details must be rendered as text"); },
  }]));
  const element = (id: string) => {
    const el = elements.get(id);
    assert.ok(el, `Missing page element: ${id}`);
    return el;
  };
  const confirmations: string[] = [];
  const requests: FakeRequest[] = [];
  class FakeRequest {
    method = "";
    url = "";
    readyState = 0;
    status = 0;
    responseText = "";
    sent = false;
    onreadystatechange = () => {};
    constructor() { requests.push(this); }
    open(method: string, url: string, async: boolean) {
      assert.equal(async, true);
      this.method = method;
      this.url = url;
    }
    send() { this.sent = true; }
    respond(status: number, response: unknown) {
      this.status = status;
      this.responseText = typeof response === "string" ? response : JSON.stringify(response);
      this.readyState = 4;
      this.onreadystatechange();
    }
  }
  const context = {
    document: { getElementById: element },
    confirm: (message: string) => { confirmations.push(message); return confirmed; },
    XMLHttpRequest: FakeRequest,
    location: { reload: () => assert.fail("Regeneration must not reload the page") },
    occRegenerateCertificate: () => {},
  };
  runInNewContext(script, context);
  return { context, confirmations, requests, element };
}

test("certificate regeneration requires confirmation describing backups, restart and trust", () => {
  const ui = fixture(false);
  ui.context.occRegenerateCertificate();
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.element("occ-regenerate-cert-btn").disabled, false);
  assert.match(ui.confirmations[0], /certificate and key.*cert\.pem\.bak and key\.pem\.bak/);
  assert.match(ui.confirmations[0], /service restarts/);
  assert.match(ui.confirmations[0], /trusted the old certificate must trust the new one/);
});

test("certificate regeneration uses GET and refreshes details as text without reloading", () => {
  const ui = fixture();
  ui.context.occRegenerateCertificate();
  assert.equal(ui.requests.length, 1);
  const request = ui.requests[0];
  assert.equal(request.method, "GET");
  assert.equal(request.url, "/plugins/unraidclaw/php/regenerate-cert.php?action=regenerate");
  assert.equal(request.sent, true);
  assert.equal(ui.element("occ-regenerate-cert-btn").disabled, true);
  request.respond(200, { success: true, certificate: {
    subject: "CN=<fixture>", subjectAltName: ["DNS:tls-test", "IP Address:192.0.2.10"], expiry: "fixture expiry", fingerprint: "fixture fingerprint",
  } });
  assert.equal(ui.element("occ-cert-subject").textContent, "CN=<fixture>");
  assert.equal(ui.element("occ-cert-san").textContent, "DNS:tls-test, IP Address:192.0.2.10");
  assert.equal(ui.element("occ-cert-expiry").textContent, "fixture expiry");
  assert.equal(ui.element("occ-cert-fingerprint").textContent, "fixture fingerprint");
  for (const field of ["subject", "san", "expiry", "fingerprint"]) {
    assert.equal(ui.element(`occ-cert-${field}-row`).style.display, "");
  }
  assert.equal(ui.element("occ-cert-state-row").style.display, "none");
  assert.equal(ui.element("occ-cert-san-warning").style.display, "none");
  assert.equal(ui.element("occ-regenerate-cert-btn").disabled, false);
  assert.match(ui.element("occ-cert-status").textContent, /Clients must trust the new certificate/);
});

test("a regenerated certificate without SAN keeps the strict-client warning visible", () => {
  const ui = fixture();
  ui.context.occRegenerateCertificate();
  ui.requests[0].respond(200, { success: true, certificate: {
    subject: "CN=fixture", subjectAltName: [], expiry: "fixture expiry", fingerprint: "fixture fingerprint",
  } });
  assert.equal(ui.element("occ-cert-san-warning").style.display, "");
  assert.equal(ui.element("occ-cert-san").textContent, "");
});

test("regeneration errors preserve displayed details and re-enable the button", () => {
  for (const [status, response] of [
    [500, { success: false, error: "Could not move the TLS files." }],
    [200, { success: false, error: "Could not move the TLS files." }],
    [502, "Invalid response"],
    [0, ""],
  ] as const) {
    const ui = fixture();
    ui.context.occRegenerateCertificate();
    ui.requests[0].respond(status, response);
    assert.equal(ui.element("occ-regenerate-cert-btn").disabled, false);
    assert.equal(ui.element("occ-cert-subject").textContent, "previous details");
    assert.equal(ui.element("occ-cert-status").style.color, "#ff6b6b");
    assert.match(ui.element("occ-cert-status").textContent, /Could not/);
  }
});
