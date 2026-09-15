// Behavioural tests for the Community Applications endpoints (issue #17).
//
// Everything runs against the real Fastify routes via app.inject(). The
// catalog is a trimmed copy of the live CA feed (test/fixtures), and every
// side effect the install path has -- writing the template, creating host
// directories, running Unraid's rebuild_container -- is injected, so the
// non-dry-run path is exercised end to end without touching a real system.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { CaRuntime } from "../src/routes/ca.js";

const here = dirname(fileURLToPath(import.meta.url));

// config.ts captures FLASH_BASE at module load, so it must be set before any
// import that reaches it.
const flashBase = await mkdtemp(join(tmpdir(), "unraidclaw-test-"));
process.env.FLASH_BASE = flashBase;

const { loadPermissions } = await import("../src/config.js");
const { registerCaRoutes, createCaRuntime } = await import("../src/routes/ca.js");
const { CaFeed } = await import("../src/ca-feed.js");
const Fastify = (await import("fastify")).default;

const FIXTURE = await readFile(join(here, "fixtures", "applicationFeed.sample.json"), "utf8");

const ALL_CA = { "ca:read": true, "ca:create": true };

async function setPermissions(perms: Record<string, boolean>): Promise<void> {
  await writeFile(join(flashBase, "permissions.json"), JSON.stringify(perms), "utf8");
  loadPermissions();
}

function fixtureFeed(body = FIXTURE): InstanceType<typeof CaFeed> {
  return new CaFeed({
    fetchImpl: (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("lastUpdated")) {
        return new Response(JSON.stringify({ last_updated_timestamp: 1 }), { status: 200 });
      }
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch,
  });
}

interface Harness {
  app: ReturnType<typeof Fastify>;
  runs: Array<[string, string[]]>;
  hostDirs: string[];
  templatesDir: string;
}

async function harness(overrides: Partial<CaRuntime> = {}, body?: string): Promise<Harness> {
  const templatesDir = join(await mkdtemp(join(tmpdir(), "unraidclaw-tmpl-")), "templates-user");
  await mkdir(templatesDir, { recursive: true });

  const runs: Array<[string, string[]]> = [];
  const hostDirs: string[] = [];

  const runtime = createCaRuntime({
    feed: fixtureFeed(body),
    templatesDir,
    rebuildScript: "/fake/rebuild_container",
    readUnraidVersion: async () => "7.0.0",
    containerExists: async () => false,
    directoryExists: async () => true,
    ensureHostDir: async (p) => {
      hostDirs.push(p);
    },
    run: async (file, args) => {
      runs.push([file, args]);
      if (file === "docker" && args[0] === "inspect") return { stdout: "sha256:deadbeef\tfalse\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
    ...overrides,
  });

  const app = Fastify();
  registerCaRoutes(app, runtime);
  await app.ready();
  return { app, runs, hostDirs, templatesDir };
}

// ── Search ──────────────────────────────────────────────────────

test("search matches on name and reports the feed vintage", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({ method: "GET", url: "/api/ca/search?q=jellyfin" });

  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.query, "jellyfin");
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].name, "Jellyfin");
  assert.equal(data.results[0].repository, "jellyfin/jellyfin:latest");
  assert.equal(data.results[0].installable, true);
  assert.ok(data.feedUpdated.startsWith("20"), "feedUpdated is an ISO timestamp");
});

test("search matches description text, not just names", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({ method: "GET", url: "/api/ca/search?q=media" });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().data.results.length >= 1);
});

test("search requires every word to match", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({ method: "GET", url: "/api/ca/search?q=jellyfin%20nonexistentword" });
  assert.equal(res.json().data.results.length, 0);
});

test("search hides plugin and deprecated entries unless asked", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();

  const plain = await app.inject({ method: "GET", url: "/api/ca/search?q=reelsentry" });
  assert.equal(plain.json().data.results.length, 0, "plugin entry hidden by default");

  const withPlugins = await app.inject({ method: "GET", url: "/api/ca/search?q=reelsentry&includePlugins=true" });
  assert.equal(withPlugins.json().data.results.length, 1);
  assert.equal(withPlugins.json().data.results[0].isPlugin, true);
  assert.equal(withPlugins.json().data.results[0].installable, false);

  const deprecated = await app.inject({ method: "GET", url: "/api/ca/search?q=blueiris" });
  assert.equal(deprecated.json().data.results.length, 0, "deprecated entry hidden by default");
  const withDeprecated = await app.inject({ method: "GET", url: "/api/ca/search?q=blueiris&includeDeprecated=true" });
  assert.equal(withDeprecated.json().data.results.length, 1);
});

test("search skips the feed's broken records entirely", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  // The fixture carries one record with an `errors` array and no Name.
  const res = await app.inject({ method: "GET", url: "/api/ca/search?q=checkmk" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.results.length, 0);
});

test("search rejects an empty query", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({ method: "GET", url: "/api/ca/search?q=" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "VALIDATION_ERROR");
});

test("search is refused without ca:read", async () => {
  await setPermissions({ "ca:create": true });
  const { app } = await harness();
  const res = await app.inject({ method: "GET", url: "/api/ca/search?q=jellyfin" });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, "FORBIDDEN");
});

test("search reports a 503 when the catalog cannot be fetched", async () => {
  await setPermissions(ALL_CA);
  const feed = new CaFeed({
    fetchImpl: (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch,
  });
  const { app } = await harness({ feed });
  const res = await app.inject({ method: "GET", url: "/api/ca/search?q=jellyfin" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, "CA_FEED_UNAVAILABLE");
});

// ── App details ─────────────────────────────────────────────────

test("app details expose ports, paths, variables and the icon", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({ method: "GET", url: "/api/ca/app/Jellyfin" });

  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.name, "Jellyfin");
  assert.equal(data.network, "host");
  assert.ok(data.icon.startsWith("https://"), "icon URL is reported");
  assert.ok(data.webui.includes("[PORT:8096]"), "WebUI template is reported verbatim");
  assert.ok(data.ports.length > 0, "ports are split out");
  assert.ok(data.paths.length > 0, "paths are split out");
  assert.ok(data.variables.length > 0, "variables are split out");
  assert.equal(data.config.length, data.ports.length + data.paths.length + data.variables.length);

  const port = data.ports.find((p: { target: string }) => p.target === "8096");
  assert.ok(port, "the 8096 port entry is present");
  assert.equal(port.default, "8096");
  assert.equal(port.mode, "tcp");
});

test("app details name the required fields that have no default", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const { data } = (await app.inject({ method: "GET", url: "/api/ca/app/Jellyfin" })).json();
  // Jellyfin's /data/tvshows mount is Required with an empty Default.
  assert.ok(data.missingRequired.includes("Path: /data/tvshows"), JSON.stringify(data.missingRequired));
});

test("a duplicated app name is a 409 listing the candidates", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({ method: "GET", url: "/api/ca/app/plex" });

  assert.equal(res.statusCode, 409);
  const { error } = res.json();
  assert.equal(error.code, "CA_AMBIGUOUS_APP");
  assert.equal(error.details.candidates.length, 2);
  const repos = error.details.candidates.map((c: { repo: string }) => c.repo).sort();
  assert.deepEqual(repos, ["hotio's Repository", "linuxserver's Repository"]);
});

test("repo disambiguates a duplicated name", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({ method: "GET", url: "/api/ca/app/plex?repo=linuxserver" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.repo, "linuxserver's Repository");
});

test("an unknown app is a 404", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({ method: "GET", url: "/api/ca/app/definitely-not-an-app" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, "CA_APP_NOT_FOUND");
});

test("app details are refused without ca:read", async () => {
  await setPermissions({});
  const { app } = await harness();
  const res = await app.inject({ method: "GET", url: "/api/ca/app/Jellyfin" });
  assert.equal(res.statusCode, 403);
});

// ── Blockers: refuse rather than install something different ────

test("a template with Extra Parameters is refused", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/plex/install",
    payload: { repo: "hotio" },
  });

  assert.equal(res.statusCode, 422);
  const { error } = res.json();
  assert.equal(error.code, "CA_NOT_INSTALLABLE");
  const codes = error.details.blockers.map((b: { code: string }) => b.code);
  assert.ok(codes.includes("CA_EXTRA_PARAMS"), JSON.stringify(codes));
});

test("a privileged template is refused", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({ method: "POST", url: "/api/ca/app/cncjs/install", payload: {} });
  assert.equal(res.statusCode, 422);
  const codes = res.json().error.details.blockers.map((b: { code: string }) => b.code);
  assert.ok(codes.includes("CA_PRIVILEGED"), JSON.stringify(codes));
  assert.ok(codes.includes("CA_DEVICE_PASSTHROUGH"), "device passthrough is also refused");
});

test("a plugin entry is refused", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({ method: "POST", url: "/api/ca/app/ReelSentry/install", payload: {} });
  assert.equal(res.statusCode, 422);
  const codes = res.json().error.details.blockers.map((b: { code: string }) => b.code);
  assert.ok(codes.includes("CA_PLUGIN_ENTRY"), JSON.stringify(codes));
});

test("a custom network is refused rather than silently dropping every port", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({ method: "POST", url: "/api/ca/app/quakejs/install", payload: {} });
  assert.equal(res.statusCode, 422);
  const blockers = res.json().error.details.blockers;
  const blocker = blockers.find((b: { code: string }) => b.code === "CA_UNSUPPORTED_NETWORK");
  assert.ok(blocker, JSON.stringify(blockers));
  assert.ok(blocker.message.includes("br0"));
});

test("an Unraid version below the template minimum is refused", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness({ readUnraidVersion: async () => "6.0.0" });
  const res = await app.inject({ method: "POST", url: "/api/ca/app/poptonium/install", payload: {} });
  assert.equal(res.statusCode, 422);
  const codes = res.json().error.details.blockers.map((b: { code: string }) => b.code);
  assert.ok(codes.includes("CA_MIN_VERSION"), JSON.stringify(codes));
});

test("the same template installs when the server is new enough", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness({ readUnraidVersion: async () => "7.0.0" });
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/poptonium/install",
    payload: { dryRun: true },
  });
  assert.notEqual(res.json().error?.code, "CA_MIN_VERSION");
});

// ── Install: validation ─────────────────────────────────────────

test("a required field with no default must be supplied", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/Jellyfin/install",
    payload: { dryRun: true },
  });

  assert.equal(res.statusCode, 400);
  const { error } = res.json();
  assert.equal(error.code, "CA_MISSING_REQUIRED");
  assert.ok(error.details.missingRequired.includes("Path: /data/tvshows"));
});

test("an override for an unknown field is an error, never ignored", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { dryRun: true, overrides: { NOT_A_REAL_FIELD: "x" } },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "CA_UNKNOWN_OVERRIDE");
});

test("a container name with shell metacharacters is refused", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  // Unraid interpolates the name unescaped into HOST_CONTAINERNAME="...".
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { dryRun: true, name: 'x";$(id);"y' },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "CA_INVALID_NAME");
});

test("an out-of-range port override is refused", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { dryRun: true, overrides: { "8080": "99999" } },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "CA_INVALID_VALUE");
});

test("install is refused without ca:create even when ca:read is granted", async () => {
  await setPermissions({ "ca:read": true });
  const { app } = await harness();
  const res = await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: { dryRun: true } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, "FORBIDDEN");
});

// ── Install: dry run ────────────────────────────────────────────

test("a dry run returns the resolved plan and changes nothing", async () => {
  await setPermissions(ALL_CA);
  const { app, runs, hostDirs, templatesDir } = await harness();
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { dryRun: true },
  });

  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.dryRun, true);
  assert.equal(data.plan.name, "MeshVault");
  assert.equal(data.plan.image, "ghcr.io/007darkmatter5/meshvault:latest");
  assert.equal(data.plan.network, "bridge");
  assert.ok(data.plan.ports.some((p: string) => p.startsWith("8080:8080/")), JSON.stringify(data.plan.ports));
  assert.ok(data.plan.volumes.length >= 2, JSON.stringify(data.plan.volumes));
  assert.ok(data.plan.templateXml.startsWith('<?xml version="1.0"?>'));
  assert.equal(data.plan.templatePath, join(templatesDir, "my-MeshVault.xml"));
  assert.ok(data.plan.dockerCommandPreview.includes("--name=MeshVault"));
  assert.ok(data.plan.dockerCommandPreview.includes("net.unraid.docker.managed=dockerman"));

  assert.deepEqual(runs, [], "nothing was executed");
  assert.deepEqual(hostDirs, [], "no host directory was created");
  assert.deepEqual(await readdir(templatesDir), [], "no template was written");
});

test("a dry run applies overrides to the plan", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { dryRun: true, overrides: { "8080": "18080", "/data": "/mnt/user/appdata/mv" } },
  });

  const { plan } = res.json().data;
  assert.ok(plan.ports.includes("18080:8080/tcp"), JSON.stringify(plan.ports));
  assert.ok(
    plan.volumes.some((v: string) => v.startsWith("/mnt/user/appdata/mv:/data:")),
    JSON.stringify(plan.volumes)
  );
});

test("host networking turns ports into environment variables, as Unraid does", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/Jellyfin/install",
    payload: {
      dryRun: true,
      overrides: {
        "/data/tvshows": "/mnt/user/media/tv",
        "/data/movies": "/mnt/user/media/movies",
      },
    },
  });

  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.plan.network, "host");
  assert.deepEqual(data.plan.ports, [], "host networking publishes no ports");
  assert.ok(data.plan.env.includes("TCP_PORT_8096=8096"), JSON.stringify(data.plan.env));
  assert.ok(data.plan.env.includes("UDP_PORT_7359=7359"), "the port's protocol is honoured");
  assert.ok(
    data.warnings.some((w: string) => w.includes("host networking")),
    "the caller is told why no ports are published"
  );
});

test("the template's own prerequisites are surfaced as a warning", async () => {
  await setPermissions(ALL_CA);
  const feed = JSON.parse(FIXTURE);
  feed.applist.find((a: { Name?: string }) => a.Name === "MeshVault").Requires =
    "You must create an API key first.";
  const { app } = await harness({}, JSON.stringify(feed));

  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { dryRun: true },
  });

  assert.equal(res.statusCode, 200);
  assert.ok(
    res.json().data.warnings.some((w: string) => w.includes("You must create an API key first.")),
    JSON.stringify(res.json().data.warnings)
  );
});

test("all required paths must be supplied, not just the first", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/Jellyfin/install",
    payload: { dryRun: true, overrides: { "/data/tvshows": "/mnt/user/media/tv" } },
  });

  assert.equal(res.statusCode, 400);
  const { error } = res.json();
  assert.equal(error.code, "CA_MISSING_REQUIRED");
  assert.deepEqual(error.details.missingRequired, ["Path: /data/movies"]);
});

test("hostile template text is XML-escaped exactly once", async () => {
  await setPermissions(ALL_CA);
  const hostile = JSON.parse(FIXTURE);
  const app_ = hostile.applist.find((a: { Name?: string }) => a.Name === "MeshVault");
  app_.Overview = 'Ampersand & <script>alert("x")</script>';
  const { app } = await harness({}, JSON.stringify(hostile));

  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { dryRun: true },
  });

  const xml = res.json().data.plan.templateXml;
  assert.ok(xml.includes("Ampersand &amp; &lt;script&gt;"), xml.slice(0, 400));
  assert.ok(!xml.includes("&amp;amp;"), "not double-encoded");
  assert.ok(!xml.includes("<script>"), "no raw markup survives");
});

// ── Install: the real thing ─────────────────────────────────────

test("a real install writes the template, creates host paths and runs rebuild_container", async () => {
  await setPermissions(ALL_CA);
  const { app, runs, hostDirs, templatesDir } = await harness();
  const res = await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: {} });

  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.dryRun, false);
  assert.equal(data.containerId, "sha256:deadbeef");

  const written = await readdir(templatesDir);
  assert.deepEqual(written, ["my-MeshVault.xml"]);
  const xml = await readFile(join(templatesDir, "my-MeshVault.xml"), "utf8");
  assert.ok(xml.includes("<Name>MeshVault</Name>"));
  assert.ok(xml.includes("<ExtraParams/>"), "ExtraParams is always written empty");
  assert.ok(xml.includes("<PostArgs/>"), "PostArgs is always written empty");
  assert.ok(xml.includes("<Privileged>false</Privileged>"));

  assert.ok(hostDirs.length >= 2, "host directories were created");

  // Unraid builds and runs the container from the template we wrote.
  assert.deepEqual(runs[0], ["/fake/rebuild_container", ["MeshVault"]]);
  // Its exit code proves nothing, so the container is confirmed by inspect.
  assert.equal(runs[1][0], "docker");
  assert.equal(runs[1][1][0], "inspect");
  // rebuild_container leaves the container stopped unless it is in the
  // autostart list, so the install starts it.
  assert.deepEqual(runs[2], ["docker", ["start", "MeshVault"]]);
});

test("a real install honours an explicit container name", async () => {
  await setPermissions(ALL_CA);
  const { app, runs, templatesDir } = await harness();
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { name: "meshvault-2" },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(await readdir(templatesDir), ["my-meshvault-2.xml"]);
  assert.deepEqual(runs[0], ["/fake/rebuild_container", ["meshvault-2"]]);
});

test("an existing template is never replaced", async () => {
  await setPermissions(ALL_CA);
  const { app, runs, templatesDir } = await harness();
  const path = join(templatesDir, "my-MeshVault.xml");
  await writeFile(path, "<Container>original</Container>", "utf8");

  const res = await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: {} });

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "CA_TEMPLATE_EXISTS");
  assert.equal(await readFile(path, "utf8"), "<Container>original</Container>", "left untouched");
  assert.deepEqual(runs, [], "nothing was executed");
});

test("an existing template is matched case-insensitively, as Unraid does", async () => {
  await setPermissions(ALL_CA);
  const { app, templatesDir } = await harness();
  await writeFile(join(templatesDir, "my-meshvault.xml"), "<Container/>", "utf8");

  const res = await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: {} });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "CA_TEMPLATE_EXISTS");
});

test("an existing container is never clobbered", async () => {
  await setPermissions(ALL_CA);
  // Unraid's rebuild_container removes any container of this name first, so
  // installing over one would destroy it.
  const { app, runs, templatesDir } = await harness({ containerExists: async () => true });

  const res = await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: {} });

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "CA_CONTAINER_EXISTS");
  assert.deepEqual(runs, [], "nothing was executed");
  assert.deepEqual(await readdir(templatesDir), [], "no template was written");
});

test("a concurrent install loses the race instead of clobbering", async () => {
  await setPermissions(ALL_CA);
  const { app, runs } = await harness({
    // Simulates another request winning the exclusive create between the
    // collision check and the write.
    claimTemplate: async () => {
      const err = new Error("EEXIST: file already exists") as NodeJS.ErrnoException;
      err.code = "EEXIST";
      throw err;
    },
  });

  const res = await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: {} });

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "CA_TEMPLATE_EXISTS");
  assert.ok(res.json().error.message.includes("Nothing was changed"));
  assert.deepEqual(runs, [], "nothing was executed");
});

test("two concurrent installs of the same app produce exactly one container", async () => {
  await setPermissions(ALL_CA);
  const { app, runs, templatesDir } = await harness();

  const [a, b] = await Promise.all([
    app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: {} }),
    app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: {} }),
  ]);

  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [200, 409], "one wins, one is refused");
  assert.deepEqual(await readdir(templatesDir), ["my-MeshVault.xml"]);
  const rebuilds = runs.filter(([f]) => f === "/fake/rebuild_container");
  assert.equal(rebuilds.length, 1, "rebuild_container ran once");
});

test("a failed install keeps the template and says so", async () => {
  await setPermissions(ALL_CA);
  const { app, templatesDir } = await harness({
    run: async (file) => {
      if (file === "/fake/rebuild_container") throw new Error("no such image");
      return { stdout: "", stderr: "" };
    },
  });

  const res = await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: {} });

  assert.equal(res.statusCode, 500);
  const { error } = res.json();
  assert.equal(error.code, "CA_INSTALL_FAILED");
  assert.ok(error.message.includes("no such image"), error.message);
  assert.ok(error.message.includes("template was kept"), error.message);
  assert.deepEqual(await readdir(templatesDir), ["my-MeshVault.xml"], "template preserved for retry");
});

test("a host directory failure aborts before the container is built", async () => {
  await setPermissions(ALL_CA);
  const { app, runs } = await harness({
    ensureHostDir: async () => {
      throw new Error("read-only file system");
    },
  });

  const res = await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: {} });

  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "CA_HOST_PATH_FAILED");
  assert.deepEqual(runs, [], "rebuild_container never ran");
});

test("a container that will not start is reported rather than claimed as running", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness({
    run: async (file, args) => {
      if (file === "docker" && args[0] === "start") throw new Error("port is already allocated");
      if (file === "docker" && args[0] === "inspect") return { stdout: "sha256:deadbeef\tfalse\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  });

  const res = await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: {} });

  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  // The container was verified to exist, so it is reported; only the start
  // failed, and that is a warning rather than a silent success.
  assert.equal(data.containerId, "sha256:deadbeef");
  assert.ok(
    data.warnings.some((w: string) => w.includes("could not be started")),
    JSON.stringify(data.warnings)
  );
});

// ── rebuild_container lies about success ────────────────────────

test("an install is failed when no container exists, whatever the helper's exit code", async () => {
  await setPermissions(ALL_CA);
  // rebuild_container ignores the exit status of the docker command it runs,
  // so it exits 0 even when the image pull or the create failed.
  const { app, templatesDir } = await harness({
    run: async (file, args) => {
      if (file === "/fake/rebuild_container") return { stdout: "", stderr: "" };
      if (args[0] === "inspect") throw new Error("No such object: MeshVault");
      return { stdout: "", stderr: "" };
    },
  });

  const res = await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: {} });

  assert.equal(res.statusCode, 500);
  const { error } = res.json();
  assert.equal(error.code, "CA_INSTALL_FAILED");
  assert.ok(error.message.includes("no container named"), error.message);
  assert.deepEqual(await readdir(templatesDir), ["my-MeshVault.xml"], "template kept for retry");
});

test("an install is failed when inspect returns an empty id", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness({
    run: async (file, args) => {
      if (file === "docker" && args[0] === "inspect") return { stdout: "\t\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  });

  const res = await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: {} });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "CA_INSTALL_FAILED");
});

test("a container the helper already left running is not started again", async () => {
  await setPermissions(ALL_CA);
  const { app, runs } = await harness({
    run: async (file, args) => {
      if (file === "docker" && args[0] === "inspect") {
        return { stdout: "sha256:abc\ttrue\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  });

  const res = await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: {} });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.containerId, "sha256:abc");
  assert.equal(runs.filter(([f, a]) => f === "docker" && a[0] === "start").length, 0);
});

// ── Template semantics, not just the plan ───────────────────────

test("clearing a field with an empty override does not come back via Default", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  // Unraid's xmlToVar uses the Default attribute whenever the element text is
  // empty, so a stale Default would silently restore the value we cleared.
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { dryRun: true, overrides: { TZ: "" } },
  });

  assert.equal(res.statusCode, 200);
  const { plan } = res.json().data;
  assert.ok(!plan.env.some((e: string) => e.startsWith("TZ=")), JSON.stringify(plan.env));

  const tz = /<Config [^>]*Target="TZ"[^>]*Default="([^"]*)"[^>]*>([^<]*)<\/Config>/.exec(plan.templateXml);
  assert.ok(tz, "the TZ entry is in the template");
  assert.equal(tz[1], "", "Default is cleared alongside the value");
  assert.equal(tz[2], "", "element text is empty");
});

test("every template entry's Default matches the value that will be used", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { dryRun: true, overrides: { "/data": "/mnt/user/appdata/mv" } },
  });

  const { plan } = res.json().data;
  const entries = [...plan.templateXml.matchAll(/<Config [^>]*Default="([^"]*)"[^>]*>([^<]*)<\/Config>/g)];
  assert.ok(entries.length > 0);
  for (const [, def, text] of entries) {
    assert.equal(def, text, "Default and element text agree, so the fallback is a no-op");
  }
  assert.ok(plan.templateXml.includes('Default="/mnt/user/appdata/mv"'), "the override is the new default");
});

test("clearing a required port is refused", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { dryRun: true, overrides: { "8080": "" } },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "CA_MISSING_REQUIRED");
});

test("an optional port cleared by an override is dropped from the template", async () => {
  await setPermissions(ALL_CA);
  const feed = JSON.parse(FIXTURE);
  const mv = feed.applist.find((a: { Name?: string }) => a.Name === "MeshVault");
  mv.Config.find((c: any) => c["@attributes"].Type === "Port")["@attributes"].Required = "false";
  const { app } = await harness({}, JSON.stringify(feed));
  // An empty host port would make Unraid emit `-p ':8080/tcp'`, which docker
  // rejects. Omitting the entry is how "do not publish" is expressed.
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { dryRun: true, overrides: { "8080": "" } },
  });

  assert.equal(res.statusCode, 200);
  const { plan } = res.json().data;
  assert.deepEqual(plan.ports, []);
  assert.ok(!plan.templateXml.includes('Type="Port"'), "no port entry survives");
});

// ── Legacy and unrecognised templates ───────────────────────────

test("a version-1 template is refused rather than installed without its mappings", async () => {
  await setPermissions(ALL_CA);
  const feed = JSON.parse(FIXTURE);
  // Chronograf's real shape: ports and volumes live in Networking/Data, and
  // there is no Config array at all.
  feed.applist.push({
    Name: "Chronograf",
    Repository: "chronograf:latest",
    Repo: "Legacy Repository",
    Overview: "Legacy version 1 template",
    Network: "bridge",
    Privileged: "false",
    Networking: { Mode: "bridge", Publish: { Port: { HostPort: "8888", ContainerPort: "8888", Protocol: "tcp" } } },
    Data: { Volume: { HostDir: "", ContainerDir: "/var/lib/chronograf", Mode: "rw" } },
  });
  const { app } = await harness({}, JSON.stringify(feed));

  const detail = await app.inject({ method: "GET", url: "/api/ca/app/Chronograf" });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().data.installable, false, "not advertised as installable");

  const res = await app.inject({ method: "POST", url: "/api/ca/app/Chronograf/install", payload: {} });
  assert.equal(res.statusCode, 422);
  const blocker = res
    .json()
    .error.details.blockers.find((b: { code: string }) => b.code === "CA_LEGACY_TEMPLATE");
  assert.ok(blocker, JSON.stringify(res.json().error.details.blockers));
  assert.ok(blocker.message.includes("Networking"));
});

test("a config entry with an unrecognised type is refused, not dropped", async () => {
  await setPermissions(ALL_CA);
  const feed = JSON.parse(FIXTURE);
  const meshvault = feed.applist.find((a: { Name?: string }) => a.Name === "MeshVault");
  meshvault.Config.push({
    "@attributes": { Name: "Something new", Target: "/x", Default: "", Mode: "", Description: "", Type: "Secret", Display: "always", Required: "false", Mask: "false" },
    value: "",
  });
  const { app } = await harness({}, JSON.stringify(feed));

  const res = await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: {} });

  assert.equal(res.statusCode, 422);
  const blocker = res
    .json()
    .error.details.blockers.find((b: { code: string }) => b.code === "CA_UNSUPPORTED_CONFIG");
  assert.ok(blocker, JSON.stringify(res.json().error.details.blockers));
  assert.ok(blocker.message.includes("Secret"));
});

test("an app with no configurable fields at all is still installable", async () => {
  await setPermissions(ALL_CA);
  const feed = JSON.parse(FIXTURE);
  feed.applist.push({
    Name: "Plain",
    Repository: "plain/app:latest",
    Repo: "Plain Repository",
    Overview: "Nothing to configure",
    Network: "bridge",
    Privileged: "false",
  });
  const { app } = await harness({}, JSON.stringify(feed));

  const res = await app.inject({ method: "POST", url: "/api/ca/app/Plain/install", payload: { dryRun: true } });
  assert.equal(res.statusCode, 200);
});

// ── Request validation ──────────────────────────────────────────

test("a non-string repo is rejected rather than coerced", async () => {
  await setPermissions(ALL_CA);
  const { app, runs } = await harness();
  for (const repo of [5, { nested: true }, ["a"], null]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/ca/app/MeshVault/install",
      payload: { repo },
    });
    assert.equal(res.statusCode, 400, `repo=${JSON.stringify(repo)}`);
    assert.equal(res.json().error.code, "CA_INVALID_BODY");
  }
  assert.deepEqual(runs, [], "nothing was executed");
});

test("dryRun must be a real boolean, never a string", async () => {
  await setPermissions(ALL_CA);
  // "false" is the dangerous one: coerced it would mean a real install, and
  // left truthy it would mean a silent preview. Neither guess is acceptable.
  for (const dryRun of ["false", "true", "maybe", 0, 1]) {
    const { app, runs, templatesDir, hostDirs } = await harness();
    const res = await app.inject({
      method: "POST",
      url: "/api/ca/app/MeshVault/install",
      payload: { dryRun },
    });

    assert.equal(res.statusCode, 400, `dryRun=${JSON.stringify(dryRun)}`);
    const { error } = res.json();
    assert.equal(error.code, "CA_INVALID_BODY");
    assert.equal(error.details.field, "dryRun");
    assert.deepEqual(runs, [], "nothing was executed");
    assert.deepEqual(hostDirs, [], "no host directory was created");
    assert.deepEqual(await readdir(templatesDir), [], "no template was written");
  }
});

test("a mistyped dryrun is refused instead of silently installing", async () => {
  await setPermissions(ALL_CA);
  const { app, runs, templatesDir, hostDirs } = await harness();
  // The whole point: dropping this key would turn a requested preview into a
  // real install.
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { dryrun: true },
  });

  assert.equal(res.statusCode, 400);
  const { error } = res.json();
  assert.equal(error.code, "CA_INVALID_BODY");
  assert.ok(error.message.includes('Did you mean "dryRun"'), error.message);
  assert.deepEqual(runs, [], "nothing was executed");
  assert.deepEqual(hostDirs, [], "no host directory was created");
  assert.deepEqual(await readdir(templatesDir), [], "no template was written");
});

test("dryRun:false really installs", async () => {
  await setPermissions(ALL_CA);
  const { app, runs } = await harness();
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { dryRun: false },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.dryRun, false);
  assert.ok(runs.some(([f]) => f === "/fake/rebuild_container"), "the install ran");
});

test("a non-string override value is rejected rather than coerced", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  for (const value of [8080, { port: 8080 }, null, true]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/ca/app/MeshVault/install",
      payload: { dryRun: true, overrides: { "8080": value } },
    });
    assert.equal(res.statusCode, 400, JSON.stringify(value));
    assert.equal(res.json().error.code, "CA_INVALID_BODY");
  }
});

test("overrides must be an object", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness();
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { dryRun: true, overrides: ["8080=1"] },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.details.field, "overrides");
});

test("an unknown body field is refused, so no flag can be smuggled past a blocker", async () => {
  await setPermissions(ALL_CA);
  const { app, runs, templatesDir } = await harness();
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/plex/install",
    payload: { repo: "hotio", force: true, allowUnsupported: true },
  });

  assert.equal(res.statusCode, 400);
  const { error } = res.json();
  assert.equal(error.code, "CA_INVALID_BODY");
  assert.ok(error.message.includes("force"), error.message);
  assert.deepEqual(error.details.allowed, ["repo", "name", "overrides", "dryRun"]);
  assert.deepEqual(runs, []);
  assert.deepEqual(await readdir(templatesDir), []);
});

test("permission is checked before the body is validated", async () => {
  await setPermissions({ "ca:read": true });
  const { app } = await harness();
  // A caller without ca:create learns nothing about body shape.
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { dryrun: true, garbage: 1 },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, "FORBIDDEN");
});

// ── Host directory ownership ────────────────────────────────────

test("every directory created for a mount is chowned, down to the leaf", async () => {
  await setPermissions(ALL_CA);
  const realFs = await import("node:fs/promises");
  const base = await mkdtemp(join(tmpdir(), "unraidclaw-host-"));
  // Only the first two levels exist; the rest must be created and chowned.
  const existing = join(base, "mnt", "user");
  await mkdir(existing, { recursive: true });

  const chowned: string[] = [];
  const { app } = await harness({
    ensureHostDir: async (p) => {
      const created = await realFs.mkdir(p, { recursive: true, mode: 0o777 });
      if (!created) return;
      const tail = p.slice(created.length).split("/").filter(Boolean);
      let current = created;
      for (;;) {
        chowned.push(current);
        const next = tail.shift();
        if (next === undefined) break;
        current = join(current, next);
      }
    },
  });

  const deep = join(base, "mnt", "user", "appdata", "mv", "data");
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    // Both mounts must point inside the sandbox; the template's own defaults
    // are real /mnt paths.
    payload: { overrides: { "/data": deep, "/models": join(base, "mnt", "user", "models") } },
  });

  assert.equal(res.statusCode, 200);
  assert.ok(chowned.includes(join(base, "mnt", "user", "appdata")), JSON.stringify(chowned));
  assert.ok(chowned.includes(join(base, "mnt", "user", "appdata", "mv")), JSON.stringify(chowned));
  assert.ok(chowned.includes(deep), "the leaf is chowned too");
  assert.ok(!chowned.includes(existing), "an existing directory is never re-owned");
});

test("a chown failure is surfaced rather than swallowed", async () => {
  await setPermissions(ALL_CA);
  const { app, runs } = await harness({
    ensureHostDir: async () => {
      throw Object.assign(new Error("EPERM: operation not permitted, chown"), { code: "EPERM" });
    },
  });

  const res = await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: {} });

  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "CA_HOST_PATH_FAILED");
  assert.ok(res.json().error.message.includes("EPERM"), res.json().error.message);
  assert.deepEqual(runs, [], "the container was never built");
});


// ── Dropdown variables ──────────────────────────────────────────

test("a dropdown variable resolves to an option, not the raw option list", async () => {
  await setPermissions(ALL_CA);
  const feed = JSON.parse(FIXTURE);
  const mv = feed.applist.find((a: { Name?: string }) => a.Name === "MeshVault");
  mv.Config.push({
    "@attributes": { Name: "Delete Files", Target: "QBIT_DELETE_FILES", Default: "true|false", Mode: "", Description: "", Type: "Variable", Display: "always", Required: "false", Mask: "false" },
    value: "",
  });
  const { app } = await harness({}, JSON.stringify(feed));

  const detail = await app.inject({ method: "GET", url: "/api/ca/app/MeshVault" });
  const field = detail
    .json()
    .data.variables.find((v: { target: string }) => v.target === "QBIT_DELETE_FILES");
  assert.deepEqual(field.choices, ["true", "false"], "the options are reported");
  assert.equal(field.default, "true", "the first option is the default, as the WebGUI shows it");

  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { dryRun: true },
  });
  const env = res.json().data.plan.env;
  assert.ok(env.includes("QBIT_DELETE_FILES=true"), JSON.stringify(env));
  assert.ok(!env.some((e: string) => e.includes("|")), "no literal option list is installed");
});

test("a dropdown keeps the template's own selection when it is one of the options", async () => {
  await setPermissions(ALL_CA);
  const feed = JSON.parse(FIXTURE);
  const mv = feed.applist.find((a: { Name?: string }) => a.Name === "MeshVault");
  mv.Config.push({
    "@attributes": { Name: "Log Level", Target: "LOG_LEVEL", Default: "4|3|2|1|0", Mode: "", Description: "", Type: "Variable", Display: "always", Required: "false", Mask: "false" },
    value: "2",
  });
  const { app } = await harness({}, JSON.stringify(feed));

  const res = await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: { dryRun: true } });
  assert.ok(res.json().data.plan.env.includes("LOG_LEVEL=2"), JSON.stringify(res.json().data.plan.env));
});

test("a dropdown whose first option is empty resolves to nothing at all", async () => {
  await setPermissions(ALL_CA);
  const feed = JSON.parse(FIXTURE);
  const mv = feed.applist.find((a: { Name?: string }) => a.Name === "MeshVault");
  // DSMRReader's real shape: an optional serial port, unset by default.
  mv.Config.push({
    "@attributes": { Name: "Serial Port", Target: "SERIAL_PORT", Default: "|/dev/ttyUSB0", Mode: "", Description: "", Type: "Variable", Display: "always", Required: "false", Mask: "false" },
    value: "",
  });
  const { app } = await harness({}, JSON.stringify(feed));

  const res = await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: { dryRun: true } });
  const { plan } = res.json().data;
  assert.ok(!plan.env.some((e: string) => e.startsWith("SERIAL_PORT=")), JSON.stringify(plan.env));
  const entry = /<Config [^>]*Target="SERIAL_PORT"[^>]*Default="([^"]*)"[^>]*>([^<]*)<\/Config>/.exec(plan.templateXml);
  assert.ok(entry, "the entry is still in the template");
  assert.equal(entry[1], "", "Default is cleared so Unraid cannot restore an option");
  assert.equal(entry[2], "");
});

test("an override outside a dropdown's options is refused", async () => {
  await setPermissions(ALL_CA);
  const feed = JSON.parse(FIXTURE);
  const mv = feed.applist.find((a: { Name?: string }) => a.Name === "MeshVault");
  mv.Config.push({
    "@attributes": { Name: "Delete Files", Target: "QBIT_DELETE_FILES", Default: "true|false", Mode: "", Description: "", Type: "Variable", Display: "always", Required: "false", Mask: "false" },
    value: "",
  });
  const { app } = await harness({}, JSON.stringify(feed));

  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { dryRun: true, overrides: { QBIT_DELETE_FILES: "yes" } },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "CA_INVALID_VALUE");
  assert.ok(res.json().error.message.includes("true, false"), res.json().error.message);
});

test("a pipe in a path or port value is left alone", async () => {
  await setPermissions(ALL_CA);
  const feed = JSON.parse(FIXTURE);
  const mv = feed.applist.find((a: { Name?: string }) => a.Name === "MeshVault");
  mv.Config.push({
    "@attributes": { Name: "Odd Path", Target: "/odd", Default: "/mnt/user/a|b", Mode: "rw", Description: "", Type: "Path", Display: "always", Required: "false", Mask: "false" },
    value: "",
  });
  const { app } = await harness({}, JSON.stringify(feed));

  const res = await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: { dryRun: true } });
  assert.ok(
    res.json().data.plan.volumes.some((v: string) => v.startsWith("/mnt/user/a|b:")),
    JSON.stringify(res.json().data.plan.volumes)
  );
});

// ── Host path roots ─────────────────────────────────────────────

test("a missing /mnt pool is refused instead of created on the RAM rootfs", async () => {
  await setPermissions(ALL_CA);
  const { app, runs, templatesDir, hostDirs } = await harness({
    // This server has /mnt/user but no cache pool.
    directoryExists: async (p) => p === "/mnt/user",
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { overrides: { "/data": "/mnt/cache/appdata/mv" } },
  });

  assert.equal(res.statusCode, 400);
  const { error } = res.json();
  assert.equal(error.code, "CA_HOST_ROOT_MISSING");
  assert.equal(error.details.missingRoot, "/mnt/cache");
  assert.ok(error.message.includes("override"), error.message);
  assert.deepEqual(runs, [], "nothing was executed");
  assert.deepEqual(hostDirs, [], "no directory was created");
  assert.deepEqual(await readdir(templatesDir), [], "no template was written");
});

test("an existing /mnt pool is accepted", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness({ directoryExists: async (p) => p === "/mnt/user" });
  const res = await app.inject({
    method: "POST",
    url: "/api/ca/app/MeshVault/install",
    payload: { overrides: { "/data": "/mnt/user/appdata/mv", "/models": "/mnt/user/models" } },
  });
  assert.equal(res.statusCode, 200);
});

// ── Command timeouts ────────────────────────────────────────────

test("every command the install runs is bounded by a timeout", async () => {
  await setPermissions(ALL_CA);
  const timeouts: Array<number | undefined> = [];
  const { app } = await harness({
    run: async (file, args, timeoutMs) => {
      timeouts.push(timeoutMs);
      if (file === "docker" && args[0] === "inspect") return { stdout: "sha256:abc\tfalse\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  });

  await app.inject({ method: "POST", url: "/api/ca/app/MeshVault/install", payload: {} });

  // The rebuild pulls an image, so it gets a long bound; docker queries a short
  // one. What matters is that none of them is unbounded.
  assert.equal(timeouts[0], 15 * 60_000, "rebuild_container is bounded");
  for (const t of timeouts.slice(1)) {
    assert.equal(t, undefined, "docker calls fall back to the runtime's own bound");
  }
});

test("an ambiguous name is refused before anything is installed", async () => {
  await setPermissions(ALL_CA);
  const { app, runs, templatesDir } = await harness();
  const res = await app.inject({ method: "POST", url: "/api/ca/app/plex/install", payload: {} });

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "CA_AMBIGUOUS_APP");
  assert.deepEqual(runs, []);
  assert.deepEqual(await readdir(templatesDir), []);
});
