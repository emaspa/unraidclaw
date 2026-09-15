// Behavioural tests for the Unraid plugin (.plg) endpoints.
//
// Everything runs against the real Fastify routes via app.inject(). The
// filesystem is real but temporary: installed plugins are actual .plg files
// with actual /var/log/plugins-style symlinks pointing at them, so listing,
// lookup, staging and verification are exercised as written. Fixtures use the
// shape real plugin files have, with an internal DTD subset whose entities
// reference each other, because that is what the parser has to survive; the
// repo's own unraidclaw.plg is parsed too.
//
// Two things are injected: the plugin manager, so no vendor script ever runs,
// and the download, so no request ever leaves. The download's security
// decisions are not injected away with it: the address check and the body cap
// are exercised directly, against the functions the real transport calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const here = dirname(fileURLToPath(import.meta.url));
const flashBase = await mkdtemp(join(tmpdir(), "unraidclaw-plg-flash-"));
process.env.FLASH_BASE = flashBase;

const { loadPermissions } = await import("../src/config.js");
const { registerPluginRoutes } = await import("../src/routes/plugins.js");
const plugins = await import("../src/plugins.js");
const {
  createPluginsRuntime,
  clearPluginLocks,
  isPublicAddress,
  expandIpv6,
  publicOnlyLookup,
  readBounded,
  nextHop,
  parsePlg,
  attr,
  isNoInstall,
  isBuiltinName,
} = plugins;
const Fastify = (await import("fastify")).default;

const ALL = {
  "plugins:read": true,
  "plugins:create": true,
  "plugins:update": true,
  "plugins:delete": true,
};
const READ_ONLY = { "plugins:read": true };

async function setPermissions(perms: Record<string, boolean>): Promise<void> {
  await writeFile(join(flashBase, "permissions.json"), JSON.stringify(perms), "utf8");
  loadPermissions();
}

// ── Fixtures ───────────────────────────────────────────────────

/**
 * A plugin file shaped the way real ones are: metadata declared as internal
 * entities, entities referring to other entities, attributes referring to
 * those. A fixture that inlined the values would not exercise the path every
 * real plugin takes.
 */
function plg(opts: {
  name?: string;
  version?: string;
  author?: string;
  pluginURL?: string | null;
  noInstall?: string;
  files?: string;
  changes?: string;
} = {}): string {
  const {
    name = "sample.plugin",
    version = "2024.01.01",
    author = "Someone",
    pluginURL,
    noInstall,
    files = `<FILE Name="/usr/local/emhttp/plugins/sample/readme" Method="install"><URL>https://files.example.com/&name;-&version;.txz</URL></FILE>`,
    changes = "### 2024.01.01\n- first release",
  } = opts;
  const urlEntity =
    pluginURL === null ? null : pluginURL ?? "https://plugins.example.com/&repo;/&name;.plg";
  return `<?xml version='1.0' standalone='yes'?>
<!DOCTYPE PLUGIN [
<!ENTITY name      "${name}">
<!ENTITY author    "${author}">
<!ENTITY version   "${version}">
<!ENTITY repo      "example-plugins">
${urlEntity === null ? "" : `<!ENTITY pluginURL "${urlEntity}">`}
]>
<PLUGIN name="&name;" author="&author;" version="&version;"${urlEntity === null ? "" : ' pluginURL="&pluginURL;"'}${
    noInstall === undefined ? "" : ` noInstall="${noInstall}"`
  } min="6.9.0" support="https://forums.example.com/thread">
<CHANGES>${changes}</CHANGES>
${files}
</PLUGIN>
`;
}

const INLINE_SECRET = "SUPERSECRET_TOKEN_2f9a";
const INLINE_PLG = plg({
  name: "inline.plugin",
  files: `<FILE Run="/bin/bash"><INLINE>
#!/bin/bash
API_KEY=${INLINE_SECRET}
echo installing
</INLINE></FILE>`,
});

interface Harness {
  app: ReturnType<typeof Fastify>;
  runs: Array<[string, string[]]>;
  fetched: string[];
  dirs: { linkDir: string; bootDir: string; stagedDir: string; stagingDir: string };
  install(file: string, xml: string, opts?: { at?: string; via?: string }): Promise<string>;
  stage(file: string, xml: string): Promise<void>;
}

type RunImpl = (
  file: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }>;

async function harness(
  overrides: Partial<Parameters<typeof createPluginsRuntime>[0]> = {},
  runImpl?: RunImpl
): Promise<Harness> {
  clearPluginLocks();
  const base = await mkdtemp(join(tmpdir(), "unraidclaw-plg-"));
  const dirs = {
    linkDir: join(base, "var-log-plugins"),
    bootDir: join(base, "boot-config-plugins"),
    stagedDir: join(base, "tmp-plugins"),
    stagingDir: join(base, "unraidclaw-staging"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

  const runs: Array<[string, string[]]> = [];
  const fetched: string[] = [];

  const runtime = createPluginsRuntime({
    ...dirs,
    pluginCmd: "/fake/plugin",
    run: async (file, args) => {
      runs.push([file, args]);
      return runImpl ? await runImpl(file, args) : { stdout: "", stderr: "", code: 0, timedOut: false };
    },
    fetchPlg: async (url) => {
      fetched.push(url);
      return { text: plg(), finalUrl: url };
    },
    resolveHost: async () => ["93.184.216.34"],
    ...overrides,
  });

  const app = Fastify();
  registerPluginRoutes(app, runtime);
  await app.ready();

  return {
    app,
    runs,
    fetched,
    dirs,
    async install(file, xml, opts = {}) {
      const path = opts.at ?? join(dirs.bootDir, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, xml, "utf8");
      // `via` installs a second symlink in between, so the registration is a
      // chain rather than a direct link.
      if (opts.via) {
        await symlink(path, opts.via);
        await symlink(opts.via, join(dirs.linkDir, file));
      } else {
        await symlink(path, join(dirs.linkDir, file));
      }
      return path;
    },
    async stage(file, xml) {
      await writeFile(join(dirs.stagedDir, file), xml, "utf8");
    },
  };
}

/** A plugin manager stub that actually does what the real one does on success. */
function successfulManager(dirs: Harness["dirs"]): RunImpl {
  return async (_file, args) => {
    const [method, argument] = args;
    if (method === "install") {
      const xml = await readFile(argument, "utf8");
      const name = argument.split("/").pop()!;
      const target = join(dirs.bootDir, name);
      await writeFile(target, xml, "utf8");
      await symlink(target, join(dirs.linkDir, name));
    } else if (method === "update") {
      const xml = await readFile(join(dirs.stagedDir, argument), "utf8");
      const target = join(dirs.bootDir, argument);
      await rm(join(dirs.linkDir, argument));
      await writeFile(target, xml, "utf8");
      await symlink(target, join(dirs.linkDir, argument));
    } else if (method === "remove") {
      await rm(join(dirs.linkDir, argument));
      await rm(join(dirs.bootDir, argument), { force: true });
    }
    return { stdout: `plugin: ${method} ${argument} ok\n`, stderr: "", code: 0, timedOut: false };
  };
}

const post = (h: Harness, url: string, payload: unknown = {}) =>
  h.app.inject({ method: "POST", url, payload: payload as object, headers: { "content-type": "application/json" } });

const listDir = async (path: string): Promise<string[]> => (await readdir(path).catch(() => [])).sort();

// ── Parsing real plugin files ──────────────────────────────────

test("this repo's own unraidclaw.plg parses with its entities resolved", async () => {
  const xml = await readFile(join(here, "..", "..", "unraidclaw.plg"), "utf8");
  const parsed = parsePlg(xml, "unraidclaw.plg");

  assert.equal(attr(parsed, "name"), "unraidclaw");
  assert.match(attr(parsed, "version"), /^\d+\.\d+\.\d+$/);
  // pluginURL is built from &repo; and &name;, so an unexpanded value would
  // still contain an ampersand and would be downloaded as a literal reference.
  const url = attr(parsed, "pluginURL");
  assert.ok(url.startsWith("https://raw.githubusercontent.com/"), url);
  assert.ok(url.includes("unraidclaw"), url);
  assert.ok(!url.includes("&"), `pluginURL still holds an entity reference: ${url}`);
  assert.ok(parsed.files.length > 0);
});

test("a plugin file that declares an external entity is refused", async () => {
  const xxe = `<?xml version="1.0"?>
<!DOCTYPE PLUGIN [<!ENTITY xxe SYSTEM "file:///boot/config/plugins/dynamix/dynamix.cfg">]>
<PLUGIN name="sample.plugin" version="1">&xxe;</PLUGIN>`;
  assert.throws(() => parsePlg(xxe, "test"), (err: Error & { code?: string }) => err.code === "PLUGIN_INVALID_XML");
});

test("metadata is trimmed even though the parser hands back the file's own whitespace", () => {
  // The shared parser keeps values verbatim, because a saved configuration
  // value with a deliberate trailing space is somebody's choice. Plugin
  // metadata is not that: a version compared with a stray newline around it
  // never equals the same version staged without one, which would read as a
  // failed update.
  const padded = `<?xml version='1.0' standalone='yes'?>
<!DOCTYPE PLUGIN [
<!ENTITY name    "  sample.plugin  ">
<!ENTITY version "
  2024.01.01
">
]>
<PLUGIN name="&name;" version="&version;" author="  Someone  ">
<CHANGES>
  ### 2024.01.01
</CHANGES>
<FILE Name="  /usr/local/emhttp/plugins/sample/readme  " Method=" install "><URL>  https://files.example.com/x.txz  </URL></FILE>
</PLUGIN>`;
  const parsed = parsePlg(padded, "padded");

  assert.equal(attr(parsed, "name"), "sample.plugin");
  assert.equal(attr(parsed, "version"), "2024.01.01");
  assert.equal(attr(parsed, "author"), "Someone");
  assert.equal(parsed.changes, "### 2024.01.01");
  assert.equal(parsed.files[0].name, "/usr/local/emhttp/plugins/sample/readme");
  assert.equal(parsed.files[0].method, "install");
  assert.equal(parsed.files[0].url, "https://files.example.com/x.txz");
});

test("noInstall follows the plugin manager's truth test, not the English word", () => {
  const noInstall = (value?: string) => isNoInstall(parsePlg(plg({ noInstall: value }), "test"));
  assert.equal(noInstall(undefined), false);
  assert.equal(noInstall(""), false);
  assert.equal(noInstall("0"), false);
  assert.equal(noInstall("true"), true);
  // PHP counts any other non-empty string as true, so the plugin manager skips
  // registration for this one even though it reads as "no".
  assert.equal(noInstall("false"), true);
});

test("OS plugin names are matched whatever their case and suffix", () => {
  for (const value of ["unRAIDServer", "unraidserver.plg", "UNRAIDSERVER-", "unRAIDServer-.plg"]) {
    assert.equal(isBuiltinName(value), true, value);
  }
  assert.equal(isBuiltinName("unraidserver.extras"), false);
});

// ── Listing and inspection ─────────────────────────────────────

test("lists installed plugins with their metadata", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("sample.plugin.plg", plg());
  await h.install("other.plugin.plg", plg({ name: "other.plugin", version: "2023.05.05", pluginURL: null }));

  const res = await h.app.inject({ method: "GET", url: "/api/plugins" });
  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.total, 2);
  const sample = data.plugins.find((p: { file: string }) => p.file === "sample.plugin.plg");
  assert.equal(sample.name, "sample.plugin");
  assert.equal(sample.version, "2024.01.01");
  assert.equal(sample.author, "Someone");
  assert.equal(sample.pluginURL, "https://plugins.example.com/example-plugins/sample.plugin.plg");
  assert.equal(sample.builtin, false);
});

test("a staged newer version shows as an available update", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("sample.plugin.plg", plg());
  await h.stage("sample.plugin.plg", plg({ version: "2024.06.06" }));

  const { data } = (await h.app.inject({ method: "GET", url: "/api/plugins" })).json();
  assert.equal(data.plugins[0].stagedVersion, "2024.06.06");
  assert.equal(data.plugins[0].updateAvailable, true);
});

test("a dangling registration is reported as skipped, not as an installed plugin", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await symlink(join(h.dirs.bootDir, "ghost.plg"), join(h.dirs.linkDir, "ghost.plg"));

  const { data } = (await h.app.inject({ method: "GET", url: "/api/plugins" })).json();
  assert.equal(data.total, 0);
  assert.equal(data.skipped.length, 1);
  assert.equal(data.skipped[0].file, "ghost.plg");
});

test("a registration that is a plain file rather than a symlink is not an install", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await writeFile(join(h.dirs.linkDir, "planted.plg"), plg({ name: "planted" }), "utf8");

  const { data } = (await h.app.inject({ method: "GET", url: "/api/plugins" })).json();
  assert.equal(data.total, 0);
});

test("a chained symlink resolves to the real file", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("sample.plugin.plg", plg(), { via: join(h.dirs.bootDir, "indirect.link") });

  const { data } = (await h.app.inject({ method: "GET", url: "/api/plugins" })).json();
  assert.equal(data.total, 1);
  assert.equal(data.plugins[0].path, join(h.dirs.bootDir, "sample.plugin.plg"));
});

test("built-in OS plugins are listed but flagged", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("unRAIDServer.plg", plg({ name: "unRAIDServer" }));

  const { data } = (await h.app.inject({ method: "GET", url: "/api/plugins" })).json();
  assert.equal(data.plugins[0].builtin, true);
});

test("a plugin whose file lives outside /boot/config/plugins counts as built-in", async () => {
  await setPermissions(ALL);
  const h = await harness();
  const elsewhere = join(h.dirs.bootDir, "..", "usr-local", "shipped.plg");
  await h.install("shipped.plg", plg({ name: "shipped" }), { at: elsewhere });

  const { data } = (await h.app.inject({ method: "GET", url: "/api/plugins" })).json();
  assert.equal(data.plugins[0].builtin, true);
});

test("details describe FILE structure without ever echoing an inline script", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("inline.plugin.plg", INLINE_PLG);

  const res = await h.app.inject({ method: "GET", url: "/api/plugins/inline.plugin.plg" });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes(INLINE_SECRET), "inline script contents must never be returned");
  const { data } = res.json();
  assert.equal(data.files.length, 1);
  assert.equal(data.files[0].source, "INLINE");
  assert.equal(data.files[0].run, "/bin/bash");
  assert.equal(data.files[0].url, "");
  assert.equal(data.noInstall, false);
  assert.equal(data.support, "https://forums.example.com/thread");
});

test("the .plg suffix is optional when naming a plugin", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("sample.plugin.plg", plg());

  const res = await h.app.inject({ method: "GET", url: "/api/plugins/sample.plugin" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.file, "sample.plugin.plg");
});

test("an unknown plugin is a 404", async () => {
  await setPermissions(ALL);
  const h = await harness();
  const res = await h.app.inject({ method: "GET", url: "/api/plugins/nothing.plg" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, "PLUGIN_NOT_FOUND");
});

test("plugin names that are paths, traversals or options are refused", async () => {
  await setPermissions(ALL);
  const h = await harness();
  for (const name of ["..%2f..%2fetc%2fpasswd", "-rf", "%2e%2e%2fsample.plugin.plg", "sample%20plugin%3b%20rm.plg"]) {
    const res = await h.app.inject({ method: "GET", url: `/api/plugins/${name}` });
    assert.equal(res.statusCode, 400, `${name} should be refused`);
    assert.equal(res.json().error.code, "PLUGIN_INVALID_NAME");
  }
  // A bare ".." never reaches the handler: the router normalises the path away
  // before routing, which is a 404 rather than a refusal. Recorded so the
  // difference is deliberate and not mistaken for a gap.
  assert.equal((await h.app.inject({ method: "GET", url: "/api/plugins/.." })).statusCode, 404);
});

// ── Permissions ────────────────────────────────────────────────

test("every endpoint is refused when its permission is off", async () => {
  await setPermissions({});
  const h = await harness();
  await h.install("sample.plugin.plg", plg());

  const calls = [
    h.app.inject({ method: "GET", url: "/api/plugins" }),
    h.app.inject({ method: "GET", url: "/api/plugins/sample.plugin.plg" }),
    post(h, "/api/plugins/install", { url: "https://plugins.example.com/x.plg" }),
    post(h, "/api/plugins/sample.plugin.plg/check"),
    post(h, "/api/plugins/sample.plugin.plg/update"),
    post(h, "/api/plugins/sample.plugin.plg/remove"),
  ];
  for (const res of await Promise.all(calls)) {
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "FORBIDDEN");
  }
  assert.equal(h.runs.length, 0);
  assert.equal(h.fetched.length, 0);
});

test("read permission alone cannot check, update or remove", async () => {
  await setPermissions(READ_ONLY);
  const h = await harness();
  await h.install("sample.plugin.plg", plg());

  for (const action of ["check", "update", "remove"]) {
    const res = await post(h, `/api/plugins/sample.plugin.plg/${action}`);
    assert.equal(res.statusCode, 403, `${action} must not be reachable with plugins:read`);
  }
  assert.equal(h.fetched.length, 0);
  assert.equal(h.runs.length, 0);
});

// ── Body validation ────────────────────────────────────────────

test("a mistyped dryRun is refused rather than silently ignored", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("sample.plugin.plg", plg());

  const typo = await post(h, "/api/plugins/sample.plugin.plg/remove", { dryrun: true });
  assert.equal(typo.statusCode, 400);
  assert.equal(typo.json().error.code, "PLUGIN_INVALID_BODY");
  assert.match(typo.json().error.message, /Did you mean "dryRun"/);

  const coerced = await post(h, "/api/plugins/sample.plugin.plg/remove", { dryRun: "true" });
  assert.equal(coerced.statusCode, 400);
  assert.equal(h.runs.length, 0, "nothing may run for a body we refused");
});

test("install requires a url and refuses unknown fields", async () => {
  await setPermissions(ALL);
  const h = await harness();

  const missing = await post(h, "/api/plugins/install", {});
  assert.equal(missing.statusCode, 400);
  assert.match(missing.json().error.message, /"url" is required/);

  const extra = await post(h, "/api/plugins/install", {
    url: "https://plugins.example.com/x.plg",
    force: true,
  });
  assert.equal(extra.statusCode, 400);
  assert.match(extra.json().error.message, /Unknown field "force"/);
  assert.equal(h.fetched.length, 0);
});

// ── URL and address validation ─────────────────────────────────

test("install refuses URLs that are not plain public https .plg links", async () => {
  await setPermissions(ALL);
  const h = await harness();
  const bad: Array<[string, string]> = [
    ["http://plugins.example.com/x.plg", "PLUGIN_INVALID_URL"],
    ["ftp://plugins.example.com/x.plg", "PLUGIN_INVALID_URL"],
    ["file:///boot/config/plugins/x.plg", "PLUGIN_INVALID_URL"],
    ["https://user:pass@plugins.example.com/x.plg", "PLUGIN_INVALID_URL"],
    ["https://plugins.example.com/x.plg#frag", "PLUGIN_INVALID_URL"],
    ["https://plugins.example.com/x.tar.gz", "PLUGIN_INVALID_URL"],
    ["https://plugins.example.com/", "PLUGIN_INVALID_URL"],
    ["https://plugins.example.com:8443/x.plg", "PLUGIN_INVALID_URL"],
    ["https://plugins.example.com/%2e%2e%2f%2e%2e%2fetc%2fx.plg", "PLUGIN_INVALID_URL"],
    ["https://plugins.example.com/a%3Bwget%20evil%7Csh.plg", "PLUGIN_INVALID_URL"],
    ["https://plugins.example.com/-e.plg", "PLUGIN_INVALID_URL"],
    ["https://localhost/x.plg", "PLUGIN_URL_NOT_PUBLIC"],
    ["https://unraid.local/x.plg", "PLUGIN_URL_NOT_PUBLIC"],
    ["https://127.0.0.1/x.plg", "PLUGIN_URL_NOT_PUBLIC"],
    ["https://192.168.1.10/x.plg", "PLUGIN_URL_NOT_PUBLIC"],
    ["https://169.254.169.254/latest.plg", "PLUGIN_URL_NOT_PUBLIC"],
    ["https://10.0.0.5/x.plg", "PLUGIN_URL_NOT_PUBLIC"],
    ["https://[::1]/x.plg", "PLUGIN_URL_NOT_PUBLIC"],
    ["https://[::ffff:127.0.0.1]/x.plg", "PLUGIN_URL_NOT_PUBLIC"],
    ["https://[::ffff:7f00:1]/x.plg", "PLUGIN_URL_NOT_PUBLIC"],
    ["https://[0:0:0:0:0:ffff:c0a8:1]/x.plg", "PLUGIN_URL_NOT_PUBLIC"],
  ];
  for (const [url, code] of bad) {
    const res = await post(h, "/api/plugins/install", { url });
    assert.equal(res.statusCode, 400, `${url} should be refused`);
    assert.equal(res.json().error.code, code, `${url} → ${res.json().error.code}`);
  }
  assert.equal(h.fetched.length, 0, "no refused URL may be fetched");
  assert.equal(h.runs.length, 0);
});

test("IPv6 is expanded before it is classified", () => {
  assert.deepEqual(expandIpv6("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandIpv6("::ffff:127.0.0.1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  assert.deepEqual(expandIpv6("::ffff:7f00:1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  assert.equal(expandIpv6("nonsense"), null);
  assert.equal(expandIpv6("1::2::3"), null);
});

test("private addresses are private in every spelling", () => {
  const private_ = [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    // The same loopback address written as hex, which is how URL parsing
    // canonicalises it, and as a fully expanded group list.
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:0001",
    "::ffff:a9fe:a9fe",
    "::ffff:c0a8:0101",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
  ];
  for (const addr of private_) assert.equal(isPublicAddress(addr), false, `${addr} must not count as public`);
  for (const addr of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:5db8:d822"]) {
    assert.equal(isPublicAddress(addr), true, `${addr} must count as public`);
  }
});

test("the connection's own name resolution refuses a host with any private answer", async () => {
  const resolved = (addresses: string[]) =>
    new Promise<{ err: (Error & { code?: string }) | null; address?: string }>((resolve) => {
      publicOnlyLookup(async () => addresses)("host.example.com", {}, (err, address) =>
        resolve({ err: err as (Error & { code?: string }) | null, address: address as string | undefined })
      );
    });

  const rebind = await resolved(["10.0.0.7"]);
  assert.equal(rebind.err?.code, "PLUGIN_URL_NOT_PUBLIC");

  // One public answer does not excuse a private one: the socket would be free
  // to pick either.
  const mixed = await resolved(["93.184.216.34", "127.0.0.1"]);
  assert.equal(mixed.err?.code, "PLUGIN_URL_NOT_PUBLIC");

  const empty = await resolved([]);
  assert.equal(empty.err?.code, "PLUGIN_URL_UNRESOLVABLE");

  const good = await resolved(["93.184.216.34"]);
  assert.equal(good.err, null);
  assert.equal(good.address, "93.184.216.34", "the approved address is the one the socket connects to");
});

test("a redirect is held to every rule the original URL had to pass", () => {
  assert.equal(
    nextHop("/other.plg", "https://plugins.example.com/x.plg").url,
    "https://plugins.example.com/other.plg"
  );
  for (const location of ["https://169.254.169.254/latest.plg", "http://plugins.example.com/x.plg", "https://plugins.example.com/evil.sh"]) {
    assert.throws(
      () => nextHop(location, "https://plugins.example.com/x.plg"),
      (err: Error & { code?: string }) => err.code === "PLUGIN_URL_NOT_PUBLIC" || err.code === "PLUGIN_INVALID_URL",
      location
    );
  }
});

test("the body cap counts bytes as they arrive, with no declared length to trust", async () => {
  const chunks = Array.from({ length: 40 }, () => Buffer.alloc(1024, 0x61));
  const stream = Readable.from(chunks);
  const body = await readBounded(stream, 1024 * 1024, 30_000);
  assert.equal(body.byteLength, 40 * 1024);

  const flood = Readable.from(
    (function* () {
      for (;;) yield Buffer.alloc(4096, 0x61);
    })()
  );
  await assert.rejects(
    () => readBounded(flood, 16 * 1024, 30_000),
    (err: Error & { code?: string }) => err.code === "PLUGIN_TOO_LARGE"
  );
  assert.equal(flood.destroyed, true, "the stream is torn down rather than drained");
});

test("a body that dribbles bytes forever hits the deadline instead of holding the lock", async () => {
  // One byte every 10ms: under any size cap, under any idle timeout, and
  // unbounded in time. The deadline is the only thing that ends it.
  const trickle = new Readable({
    read() {
      setTimeout(() => this.push(Buffer.from("a")), 10);
    },
  });

  const started = Date.now();
  await assert.rejects(
    () => readBounded(trickle, 1024 * 1024, 60),
    (err: Error & { code?: string }) => err.code === "PLUGIN_DOWNLOAD_TIMEOUT"
  );
  assert.ok(Date.now() - started < 5_000, "the read ends at its deadline, not when the sender stops");
  assert.equal(trickle.destroyed, true, "the connection is torn down, so the plugin lock is released");
});

// ── Install ────────────────────────────────────────────────────

test("a dry-run install downloads nothing, writes nothing and runs nothing", async () => {
  await setPermissions(ALL);
  const h = await harness();

  const res = await post(h, "/api/plugins/install", {
    url: "https://plugins.example.com/sample.plugin.plg",
    dryRun: true,
  });
  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.dryRun, true);
  assert.equal(data.plan.action, "install");
  assert.equal(data.plan.file, "sample.plugin.plg");
  assert.ok(data.plan.steps.length > 0);
  assert.ok(data.plan.warnings.some((w: string) => w.includes("as root")));
  assert.equal(data.installed, undefined);
  assert.equal(h.fetched.length, 0);
  assert.equal(h.runs.length, 0);
  assert.deepEqual(await listDir(h.dirs.stagingDir), []);
  assert.deepEqual(await listDir(h.dirs.linkDir), []);
});

test("install downloads, stages, installs and verifies the registration", async () => {
  await setPermissions(ALL);
  let h: Harness;
  h = await harness({}, async (...args) => successfulManager(h.dirs)(...args));

  const res = await post(h, "/api/plugins/install", {
    url: "https://plugins.example.com/sample.plugin.plg",
  });
  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.registered, true);
  assert.equal(data.installed.name, "sample.plugin");
  assert.equal(data.installed.version, "2024.01.01");
  assert.equal(data.installed.path, join(h.dirs.bootDir, "sample.plugin.plg"));

  assert.deepEqual(h.runs, [["/fake/plugin", ["install", join(h.dirs.stagingDir, "sample.plugin.plg")]]]);
  assert.deepEqual(await listDir(h.dirs.stagingDir), [], "the staging file is cleaned up");
});

test("install refuses an OS plugin by file name before downloading anything", async () => {
  await setPermissions(ALL);
  const h = await harness();

  const res = await post(h, "/api/plugins/install", { url: "https://plugins.example.com/unRAIDServer.plg" });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "PLUGIN_PROTECTED");
  assert.equal(h.fetched.length, 0);
});

test("install refuses a download that calls itself an OS plugin", async () => {
  await setPermissions(ALL);
  const h = await harness({
    fetchPlg: async (url) => ({ text: plg({ name: "unRAIDServer" }), finalUrl: url }),
  });

  const res = await post(h, "/api/plugins/install", { url: "https://plugins.example.com/harmless.plg" });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "PLUGIN_PROTECTED");
  assert.equal(h.runs.length, 0);
});

test("install refuses a noInstall plugin before running anything", async () => {
  await setPermissions(ALL);
  const h = await harness({
    fetchPlg: async (url) => ({ text: plg({ noInstall: "true" }), finalUrl: url }),
  });

  const res = await post(h, "/api/plugins/install", { url: "https://plugins.example.com/sample.plugin.plg" });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "PLUGIN_NOINSTALL_UNSUPPORTED");
  assert.equal(h.runs.length, 0);
});

test("install refuses a plugin file with no name or version", async () => {
  await setPermissions(ALL);
  const h = await harness({
    fetchPlg: async (url) => ({ text: `<?xml version="1.0"?><PLUGIN author="x"/>`, finalUrl: url }),
  });

  const res = await post(h, "/api/plugins/install", { url: "https://plugins.example.com/sample.plugin.plg" });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "PLUGIN_INVALID_METADATA");
  assert.equal(h.runs.length, 0);
});

test("install refuses a download that is not a plugin file at all", async () => {
  await setPermissions(ALL);
  const h = await harness({ fetchPlg: async (url) => ({ text: "<html>not xml<", finalUrl: url }) });

  const res = await post(h, "/api/plugins/install", { url: "https://plugins.example.com/sample.plugin.plg" });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "PLUGIN_INVALID_XML");
  assert.equal(h.runs.length, 0);
});

test("install will not install over an installed plugin", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("sample.plugin.plg", plg());

  const res = await post(h, "/api/plugins/install", { url: "https://plugins.example.com/sample.plugin.plg" });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "PLUGIN_ALREADY_INSTALLED");
  assert.equal(h.fetched.length, 0);
});

test("an install that exits 0 without registering is reported as unverified", async () => {
  await setPermissions(ALL);
  const h = await harness({}, async () => ({ stdout: "script: executed\n", stderr: "", code: 0, timedOut: false }));

  const res = await post(h, "/api/plugins/install", { url: "https://plugins.example.com/sample.plugin.plg" });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "PLUGIN_INSTALL_UNVERIFIED");
  assert.deepEqual(await listDir(h.dirs.stagingDir), []);
});

test("an install that registers a different plugin is reported as unverified", async () => {
  await setPermissions(ALL);
  let h: Harness;
  h = await harness({}, async (_file, args) => {
    // Registers something other than what was downloaded.
    const target = join(h.dirs.bootDir, "sample.plugin.plg");
    await writeFile(target, plg({ name: "sample.plugin", version: "1999.01.01" }), "utf8");
    await symlink(target, join(h.dirs.linkDir, "sample.plugin.plg"));
    return { stdout: "", stderr: "", code: 0, timedOut: false };
  });

  const res = await post(h, "/api/plugins/install", { url: "https://plugins.example.com/sample.plugin.plg" });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "PLUGIN_INSTALL_UNVERIFIED");
});

test("a failing install reports the plugin manager's exit code and output", async () => {
  await setPermissions(ALL);
  const h = await harness({}, async () => ({
    stdout: "plugin: sample.plugin.plg download failure\n",
    stderr: "",
    code: 1,
    timedOut: false,
  }));

  const res = await post(h, "/api/plugins/install", { url: "https://plugins.example.com/sample.plugin.plg" });
  assert.equal(res.statusCode, 500);
  const { error } = res.json();
  assert.equal(error.code, "PLUGIN_INSTALL_FAILED");
  assert.equal(error.details.exitCode, 1);
  assert.match(error.details.output, /download failure/);
  assert.match(error.message, /not guaranteed untouched/);
});

// ── Check ──────────────────────────────────────────────────────

test("a dry-run check downloads nothing and stages nothing", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("sample.plugin.plg", plg());

  const res = await post(h, "/api/plugins/sample.plugin.plg/check", { dryRun: true });
  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.dryRun, true);
  assert.equal(data.installedVersion, "2024.01.01");
  assert.equal(data.latestVersion, undefined);
  assert.ok(data.plan.warnings.some((w: string) => w.includes("not a read-only operation")));
  assert.equal(h.fetched.length, 0);
  assert.deepEqual(await listDir(h.dirs.stagedDir), []);
});

test("check stages the downloaded file and reports an available update", async () => {
  await setPermissions(ALL);
  const h = await harness({
    fetchPlg: async (url) => ({ text: plg({ version: "2024.09.09" }), finalUrl: url }),
  });
  await h.install("sample.plugin.plg", plg());

  const res = await post(h, "/api/plugins/sample.plugin.plg/check");
  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.installedVersion, "2024.01.01");
  assert.equal(data.latestVersion, "2024.09.09");
  assert.equal(data.updateAvailable, true);
  assert.equal(h.runs.length, 0, "check never invokes the plugin manager, so no hooks run");
  assert.match(await readFile(join(h.dirs.stagedDir, "sample.plugin.plg"), "utf8"), /2024\.09\.09/);
});

test("check reports no update when the published version is the installed one", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("sample.plugin.plg", plg());

  const { data } = (await post(h, "/api/plugins/sample.plugin.plg/check")).json();
  assert.equal(data.updateAvailable, false);
});

test("check refuses a plugin with no pluginURL", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("sample.plugin.plg", plg({ pluginURL: null }));

  const res = await post(h, "/api/plugins/sample.plugin.plg/check");
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "PLUGIN_NO_UPDATE_URL");
  assert.equal(h.fetched.length, 0);
});

test("check refuses a pluginURL that would be unsafe in the plugin manager's own wget", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("sample.plugin.plg", plg({ pluginURL: "https://plugins.example.com/a%3Bwget%20evil.plg" }));

  const res = await post(h, "/api/plugins/sample.plugin.plg/check");
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "PLUGIN_INVALID_URL");
  assert.equal(h.fetched.length, 0);
});

test("check refuses to stage a file that is a different plugin", async () => {
  await setPermissions(ALL);
  const h = await harness({
    fetchPlg: async (url) => ({ text: plg({ name: "somethingelse", version: "9" }), finalUrl: url }),
  });
  await h.install("sample.plugin.plg", plg());

  const res = await post(h, "/api/plugins/sample.plugin.plg/check");
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "PLUGIN_IDENTITY_MISMATCH");
  assert.deepEqual(await listDir(h.dirs.stagedDir), [], "nothing is staged when identity does not match");
});

test("check refuses to stage a noInstall document", async () => {
  await setPermissions(ALL);
  const h = await harness({
    fetchPlg: async (url) => ({ text: plg({ version: "2024.09.09", noInstall: "true" }), finalUrl: url }),
  });
  await h.install("sample.plugin.plg", plg());

  const res = await post(h, "/api/plugins/sample.plugin.plg/check");
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "PLUGIN_NOINSTALL_UNSUPPORTED");
  assert.deepEqual(await listDir(h.dirs.stagedDir), []);
});

test("check refuses OS plugins", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("unRAIDServer.plg", plg({ name: "unRAIDServer" }));

  const res = await post(h, "/api/plugins/unRAIDServer.plg/check");
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "PLUGIN_PROTECTED");
  assert.equal(h.fetched.length, 0);
});

// ── Update ─────────────────────────────────────────────────────

test("update refuses when nothing is staged", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("sample.plugin.plg", plg());

  const res = await post(h, "/api/plugins/sample.plugin.plg/update");
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "PLUGIN_UPDATE_NOT_STAGED");
  assert.equal(h.runs.length, 0);
});

test("update refuses when the staged version is the installed version", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("sample.plugin.plg", plg());
  await h.stage("sample.plugin.plg", plg());

  const res = await post(h, "/api/plugins/sample.plugin.plg/update");
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "PLUGIN_ALREADY_CURRENT");
  assert.equal(h.runs.length, 0);
});

test("update refuses a staged file that is older, a different plugin, or a script", async () => {
  await setPermissions(ALL);
  const cases: Array<[string, string]> = [
    [plg({ version: "2023.01.01" }), "PLUGIN_STAGED_OLDER"],
    [plg({ name: "somethingelse", version: "2024.09.09" }), "PLUGIN_IDENTITY_MISMATCH"],
    [plg({ version: "2024.09.09", noInstall: "true" }), "PLUGIN_NOINSTALL_UNSUPPORTED"],
  ];
  for (const [staged, code] of cases) {
    const h = await harness();
    await h.install("sample.plugin.plg", plg());
    await h.stage("sample.plugin.plg", staged);

    const res = await post(h, "/api/plugins/sample.plugin.plg/update");
    assert.equal(res.json().error.code, code);
    assert.equal(h.runs.length, 0, `${code}: the plugin manager must not run`);
  }
});

test("a dry-run update runs nothing", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("sample.plugin.plg", plg());
  await h.stage("sample.plugin.plg", plg({ version: "2024.09.09" }));

  const res = await post(h, "/api/plugins/sample.plugin.plg/update", { dryRun: true });
  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.dryRun, true);
  assert.equal(data.previousVersion, "2024.01.01");
  assert.match(data.plan.steps.join(" "), /2024\.09\.09/);
  assert.equal(h.runs.length, 0);
});

test("update applies the staged file and verifies the installed version afterwards", async () => {
  await setPermissions(ALL);
  let h: Harness;
  h = await harness({}, async (...args) => successfulManager(h.dirs)(...args));
  await h.install("sample.plugin.plg", plg());
  await h.stage("sample.plugin.plg", plg({ version: "2024.09.09" }));

  const res = await post(h, "/api/plugins/sample.plugin.plg/update");
  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.verified, true);
  assert.equal(data.previousVersion, "2024.01.01");
  assert.equal(data.installedVersion, "2024.09.09");
  assert.deepEqual(h.runs, [["/fake/plugin", ["update", "sample.plugin.plg"]]]);
});

test("an update that exits 0 without changing the installed version is not called a success", async () => {
  await setPermissions(ALL);
  const h = await harness({}, async () => ({ stdout: "plugin: updated\n", stderr: "", code: 0, timedOut: false }));
  await h.install("sample.plugin.plg", plg());
  await h.stage("sample.plugin.plg", plg({ version: "2024.09.09" }));

  const res = await post(h, "/api/plugins/sample.plugin.plg/update");
  assert.equal(res.statusCode, 500);
  const { error } = res.json();
  assert.equal(error.code, "PLUGIN_UPDATE_UNVERIFIED");
  assert.equal(error.details.installedVersion, "2024.01.01");
  assert.equal(error.details.expected.version, "2024.09.09");
});

test("an update whose plugin manager fails says the system may already have changed", async () => {
  await setPermissions(ALL);
  const h = await harness({}, async () => ({
    stdout: "plugin: run failed: '/bin/bash' returned 2\n",
    stderr: "",
    code: 1,
    timedOut: false,
  }));
  await h.install("sample.plugin.plg", plg());
  await h.stage("sample.plugin.plg", plg({ version: "2024.09.09" }));

  const res = await post(h, "/api/plugins/sample.plugin.plg/update");
  assert.equal(res.statusCode, 500);
  const { error } = res.json();
  assert.equal(error.code, "PLUGIN_UPDATE_FAILED");
  assert.match(error.message, /part of the update may already have been applied/);
});

test("update refuses OS plugins and unknown plugins", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("unRAIDServer.plg", plg({ name: "unRAIDServer" }));
  await h.stage("unRAIDServer.plg", plg({ name: "unRAIDServer", version: "9999" }));

  const protectedRes = await post(h, "/api/plugins/unRAIDServer.plg/update");
  assert.equal(protectedRes.statusCode, 422);
  assert.equal(protectedRes.json().error.code, "PLUGIN_PROTECTED");

  const missing = await post(h, "/api/plugins/absent.plg/update");
  assert.equal(missing.statusCode, 404);
  assert.equal(h.runs.length, 0);
});

// ── Remove ─────────────────────────────────────────────────────

test("a dry-run remove runs nothing and says data may not survive", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("sample.plugin.plg", plg());

  const res = await post(h, "/api/plugins/sample.plugin.plg/remove", { dryRun: true });
  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.dryRun, true);
  assert.ok(data.plan.warnings.some((w: string) => /cannot promise your data survives/.test(w)));
  assert.equal(h.runs.length, 0);
  assert.deepEqual(await listDir(h.dirs.linkDir), ["sample.plugin.plg"]);
});

test("remove verifies the plugin is really gone", async () => {
  await setPermissions(ALL);
  let h: Harness;
  h = await harness({}, async (...args) => successfulManager(h.dirs)(...args));
  await h.install("sample.plugin.plg", plg());

  const res = await post(h, "/api/plugins/sample.plugin.plg/remove");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.removed, true);
  assert.deepEqual(h.runs, [["/fake/plugin", ["remove", "sample.plugin.plg"]]]);
  assert.deepEqual(await listDir(h.dirs.linkDir), []);
});

test("a remove that exits 0 but leaves the plugin registered is reported as unverified", async () => {
  await setPermissions(ALL);
  const h = await harness({}, async () => ({ stdout: "plugin: removed\n", stderr: "", code: 0, timedOut: false }));
  await h.install("sample.plugin.plg", plg());

  const res = await post(h, "/api/plugins/sample.plugin.plg/remove");
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "PLUGIN_REMOVE_UNVERIFIED");
});

test("a failing remove keeps the plugin and reports the output", async () => {
  await setPermissions(ALL);
  const h = await harness({}, async () => ({
    stdout: "plugin: run failed: '/bin/bash' returned 1\n",
    stderr: "",
    code: 1,
    timedOut: false,
  }));
  await h.install("sample.plugin.plg", plg());

  const res = await post(h, "/api/plugins/sample.plugin.plg/remove");
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "PLUGIN_REMOVE_FAILED");
  assert.match(res.json().error.details.output, /run failed/);
  assert.deepEqual(await listDir(h.dirs.linkDir), ["sample.plugin.plg"]);
});

test("remove refuses OS plugins", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("unRAIDServer.plg", plg({ name: "unRAIDServer" }));

  const res = await post(h, "/api/plugins/unRAIDServer.plg/remove");
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "PLUGIN_PROTECTED");
  assert.equal(h.runs.length, 0);
});

// ── UnraidClaw managing UnraidClaw ─────────────────────────────

test("UnraidClaw refuses to update or remove itself", async () => {
  await setPermissions(ALL);
  const h = await harness();
  await h.install("unraidclaw.plg", plg({ name: "unraidclaw" }));
  await h.stage("unraidclaw.plg", plg({ name: "unraidclaw", version: "2024.09.09" }));

  for (const action of ["update", "remove"]) {
    const res = await post(h, `/api/plugins/unraidclaw.plg/${action}`);
    assert.equal(res.statusCode, 422, action);
    assert.equal(res.json().error.code, "PLUGIN_SELF_MANAGEMENT_UNSUPPORTED");
    assert.match(res.json().error.message, /web UI|SSH/);
  }
  // Including the previews: there is nothing to preview for an action we will
  // not perform.
  const preview = await post(h, "/api/plugins/unraidclaw.plg/remove", { dryRun: true });
  assert.equal(preview.statusCode, 422);
  assert.equal(h.runs.length, 0);
});

test("UnraidClaw can still be listed, inspected and checked", async () => {
  await setPermissions(ALL);
  const h = await harness({
    fetchPlg: async (url) => ({ text: plg({ name: "unraidclaw", version: "2024.09.09" }), finalUrl: url }),
  });
  await h.install("unraidclaw.plg", plg({ name: "unraidclaw" }));

  assert.equal((await h.app.inject({ method: "GET", url: "/api/plugins/unraidclaw.plg" })).statusCode, 200);
  const check = await post(h, "/api/plugins/unraidclaw.plg/check");
  assert.equal(check.statusCode, 200, "a check runs no plugin script, so it is safe on ourselves");
  assert.equal(check.json().data.updateAvailable, true);
  assert.equal(h.runs.length, 0);
});

test("install refuses to overwrite UnraidClaw, by file name or by metadata", async () => {
  await setPermissions(ALL);
  const byName = await harness();
  const first = await post(byName, "/api/plugins/install", { url: "https://plugins.example.com/unraidclaw.plg" });
  assert.equal(first.statusCode, 422);
  assert.equal(first.json().error.code, "PLUGIN_SELF_MANAGEMENT_UNSUPPORTED");
  assert.equal(byName.fetched.length, 0);

  const byMetadata = await harness({
    fetchPlg: async (url) => ({ text: plg({ name: "unraidclaw" }), finalUrl: url }),
  });
  const second = await post(byMetadata, "/api/plugins/install", { url: "https://plugins.example.com/harmless.plg" });
  assert.equal(second.statusCode, 422);
  assert.equal(second.json().error.code, "PLUGIN_SELF_MANAGEMENT_UNSUPPORTED");
  assert.equal(byMetadata.runs.length, 0);
});

// ── What changes between the preflight and the action ──────────

test("update acts on the staged file as it is under the lock, not as it was at preflight", async () => {
  await setPermissions(ALL);
  // The staged file reads as a newer version during the preflight and as an
  // older one by the time the lock is held, which is what a concurrent check or
  // a hand-edited /tmp/plugins looks like.
  let reads = 0;
  const real = createPluginsRuntime();
  const h = await harness({
    readPlg: async (path) => {
      if (path.includes("tmp-plugins")) {
        reads++;
        return plg({ version: reads === 1 ? "2024.09.09" : "2023.01.01" });
      }
      return await real.readPlg(path);
    },
  });
  await h.install("sample.plugin.plg", plg());
  await h.stage("sample.plugin.plg", plg({ version: "2024.09.09" }));

  const res = await post(h, "/api/plugins/sample.plugin.plg/update");
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "PLUGIN_STAGED_OLDER");
  assert.ok(reads >= 2, "the staged file is read again under the lock");
  assert.equal(h.runs.length, 0, "nothing runs once the second read disagrees");
});

test("remove re-checks under the lock that the plugin is still ours to remove", async () => {
  await setPermissions(ALL);
  let reads = 0;
  const real = createPluginsRuntime();
  let bootDir = "";
  const h = await harness({
    readLink: async (path) => {
      const target = await real.readLink(path);
      if (target === null) return null;
      reads++;
      // On the second read the plugin file has moved out of the flash
      // directory, which is how an OS-owned plugin looks.
      return reads === 1 ? target : join(bootDir, "..", "usr-local", "sample.plugin.plg");
    },
  });
  bootDir = h.dirs.bootDir;
  const moved = join(h.dirs.bootDir, "..", "usr-local", "sample.plugin.plg");
  await mkdir(dirname(moved), { recursive: true });
  await writeFile(moved, plg(), "utf8");
  await h.install("sample.plugin.plg", plg());

  const res = await post(h, "/api/plugins/sample.plugin.plg/remove");
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "PLUGIN_PROTECTED");
  assert.equal(h.runs.length, 0);
});

// ── Concurrency and output handling ────────────────────────────

test("two mutations of the same plugin do not overlap", async () => {
  await setPermissions(ALL);
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const h = await harness({}, async () => {
    await gate;
    return { stdout: "", stderr: "", code: 1, timedOut: false };
  });
  await h.install("sample.plugin.plg", plg());

  const first = post(h, "/api/plugins/sample.plugin.plg/remove");
  await new Promise((r) => setTimeout(r, 20));
  const second = await post(h, "/api/plugins/sample.plugin.plg/remove");
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error.code, "PLUGIN_BUSY");
  release();
  await first;
});

test("plugin manager output is bounded", async () => {
  await setPermissions(ALL);
  const h = await harness({}, async () => ({
    stdout: "noise\n".repeat(20_000),
    stderr: "",
    code: 1,
    timedOut: false,
  }));
  await h.install("sample.plugin.plg", plg());

  const res = await post(h, "/api/plugins/sample.plugin.plg/remove");
  const output: string = res.json().error.details.output;
  assert.ok(output.length < 9000, `output was ${output.length} characters`);
  assert.match(output, /output truncated$/);
});

test("a plugin manager that hangs is reported as a timeout, not a success", async () => {
  await setPermissions(ALL);
  const h = await harness({}, async () => ({ stdout: "", stderr: "", code: 1, timedOut: true }));
  await h.install("sample.plugin.plg", plg());

  const res = await post(h, "/api/plugins/sample.plugin.plg/remove");
  assert.equal(res.statusCode, 504);
  assert.equal(res.json().error.code, "PLUGIN_REMOVE_TIMEOUT");
});
