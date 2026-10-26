import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, utimes, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { GraphQLClient } from "../src/graphql-client.js";
import type { CommandRunner } from "../src/docker-common.js";

const root = await mkdtemp(join(tmpdir(), "docker-images-"));
process.env.FLASH_BASE = root;
const { loadPermissions } = await import("../src/config.js");
const { registerDockerRoutes } = await import("../src/routes/docker.js");
const { unraidImageKey, parsePruneBody } = await import("../src/docker-images.js");
after(() => rm(root, { recursive: true, force: true }));

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "unraid-update-status.json");
const NOW = new Date("2026-10-17T12:00:00Z");

async function setPermissions(perms: Record<string, boolean>) {
  await writeFile(join(root, "permissions.json"), JSON.stringify(perms));
  loadPermissions();
}
const READ = { "docker:read": true };
const ALL = { "docker:read": true, "docker:delete": true };

const sha = (c: string) => `sha256:${c.repeat(64)}`;
const cid = (c: string) => c.repeat(64);

/** hidden: an untagged image only the dangling filter lists, as the containerd store does after an update pull. */
interface FakeImage { id: string; tags: string[]; size: number; created: string; hidden?: boolean }
interface FakeContainer { id: string; name: string; imageId: string; image: string; state: string }

/** A fake docker CLI: images and containers in memory, every call recorded. */
function fakeDocker(images: FakeImage[], containers: FakeContainer[], opts: { rmiFails?: Record<string, string>; rmiNoop?: string[] } = {}) {
  const calls: string[][] = [];
  const run: CommandRunner = async (file, args, options) => {
    assert.equal(file, "docker");
    assert.ok(options.timeout > 0 && options.timeout <= 120000, "every command is bounded");
    calls.push(args);
    const out = (s: string) => ({ stdout: s, stderr: "" });
    if (args[0] === "image" && args[1] === "ls") {
      const danglingOnly = args.includes("dangling=true");
      return out(images.filter((i) => danglingOnly ? i.tags.length === 0 : !i.hidden).map((i) => `${i.id}\n`).join(""));
    }
    if (args[0] === "ps") return out(containers.map((c) => `${c.id}\n`).join(""));
    if (args[0] === "image" && args[1] === "inspect") {
      const ids = args.slice(args.indexOf("--") + 1);
      return out(images.filter((i) => ids.includes(i.id))
        .map((i) => `${JSON.stringify([i.id, i.tags.length ? i.tags : null, i.size, i.created])}\n`).join(""));
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const ids = args.slice(args.indexOf("--") + 1);
      return out(containers.filter((c) => ids.includes(c.id))
        .map((c) => `${JSON.stringify([c.id, `/${c.name}`, c.imageId, c.image, c.state])}\n`).join(""));
    }
    if (args[0] === "rmi") {
      assert.equal(args[1], "--", "rmi never takes an option from data");
      const targets = args.slice(2);
      const image = images.find((i) => targets.includes(i.id) || i.tags.some((t) => targets.includes(t)));
      if (image && opts.rmiFails?.[image.id]) {
        throw Object.assign(new Error("Command failed"), { stderr: opts.rmiFails[image.id] });
      }
      if (image && !opts.rmiNoop?.includes(image.id)) images.splice(images.indexOf(image), 1);
      return out("Deleted\n");
    }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  return { run, calls };
}

function sampleHost() {
  const images: FakeImage[] = [
    { id: sha("a"), tags: ["lscr.io/linuxserver/plex:latest"], size: 300, created: "2026-10-01T00:00:00Z" },
    { id: sha("b"), tags: [], size: 100, created: "2026-09-01T00:00:00Z" },
    { id: sha("c"), tags: [], size: 50, created: "2026-10-17T11:00:00Z" },
    { id: sha("d"), tags: ["nginx:1.25"], size: 70, created: "2026-08-01T00:00:00Z" },
    { id: sha("e"), tags: [], size: 40, created: "2026-08-01T00:00:00Z" },
    { id: sha("f"), tags: ["ghcr.io/example/old:1", "ghcr.io/example/old:stable"], size: 20, created: "2026-01-01T00:00:00Z" },
  ];
  const containers: FakeContainer[] = [
    { id: cid("1"), name: "plex", imageId: sha("a"), image: "lscr.io/linuxserver/plex", state: "running" },
    // A stopped container still holds its untagged image.
    { id: cid("2"), name: "old-tool", imageId: sha("e"), image: "example/tool:latest", state: "exited" },
  ];
  return { images, containers };
}

function graphql() {
  return { query: async () => { throw new Error("no GraphQL"); } } as unknown as GraphQLClient;
}

async function harness(docker: ReturnType<typeof fakeDocker>, updateStatusPath = FIXTURE) {
  const app = Fastify();
  registerDockerRoutes(app, graphql(), { run: docker.run, updateStatusPath, now: () => NOW });
  return app;
}

// ── Listing ─────────────────────────────────────────────────────

test("images list which containers use them, stopped ones included, with totals", async (t) => {
  await setPermissions(READ);
  const { images, containers } = sampleHost();
  const app = await harness(fakeDocker(images, containers)); t.after(() => app.close());
  const res = await app.inject({ method: "GET", url: "/api/docker/images" });
  assert.equal(res.statusCode, 200, res.body);
  const { images: list, totals } = res.json().data;
  const byId = (c: string) => list.find((i: { id: string }) => i.id === sha(c));
  assert.deepEqual(byId("a").inUseBy, ["plex"]);
  assert.equal(byId("a").unused, false);
  assert.equal(byId("b").dangling, true);
  assert.equal(byId("b").unused, true);
  assert.deepEqual(byId("e").inUseBy, ["old-tool"], "a stopped container counts");
  assert.equal(byId("e").unused, false);
  assert.deepEqual(totals, {
    count: 6, sizeBytes: 580,
    danglingCount: 3, danglingSizeBytes: 190,
    unusedCount: 4, unusedSizeBytes: 240,
  });
});

test("listing images needs docker:read", async (t) => {
  await setPermissions({});
  const docker = fakeDocker([], []);
  const app = await harness(docker); t.after(() => app.close());
  for (const url of ["/api/docker/images", "/api/docker/updates"]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 403);
  }
  assert.deepEqual(docker.calls, []);
});

// ── Prune ───────────────────────────────────────────────────────

test("prune needs docker:delete and validates its body before running anything", async (t) => {
  await setPermissions(READ);
  const docker = fakeDocker(...Object.values(sampleHost()) as [FakeImage[], FakeContainer[]]);
  const app = await harness(docker); t.after(() => app.close());
  assert.equal((await app.inject({ method: "POST", url: "/api/docker/images/prune", payload: { dryRun: true } })).statusCode, 403);
  await setPermissions(ALL);
  for (const payload of [
    { dryRun: "true" }, { dryRun: 1 }, { dryRun: null }, { mode: "all" }, { mode: 1 }, { extra: true },
    { olderThanHours: -1 }, { olderThanHours: 1.5 }, { olderThanHours: "24" }, { olderThanHours: 87601 }, [],
  ]) {
    const res = await app.inject({ method: "POST", url: "/api/docker/images/prune", payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().error.code, "VALIDATION_ERROR");
  }
  assert.deepEqual(docker.calls, [], "nothing ran for a refused body");
  assert.deepEqual(parsePruneBody(undefined), { dryRun: false, mode: "dangling" });
});

test("a dry run lists exactly the dangling images no container uses, and removes nothing", async (t) => {
  await setPermissions(ALL);
  const { images, containers } = sampleHost();
  const docker = fakeDocker(images, containers);
  const app = await harness(docker); t.after(() => app.close());
  const res = await app.inject({ method: "POST", url: "/api/docker/images/prune", payload: { dryRun: true } });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.equal(data.mode, "dangling");
  assert.deepEqual(data.images.map((i: { id: string }) => i.id), [sha("b"), sha("c")]);
  assert.equal(data.reclaimableBytes, 150);
  assert.deepEqual(data.removed, []);
  assert.ok(!docker.calls.some((c) => c[0] === "rmi"), "a dry run never removes");
  assert.equal(images.length, 6);
});

test("unused mode with an age filter never touches an image a container uses", async (t) => {
  await setPermissions(ALL);
  const { images, containers } = sampleHost();
  const docker = fakeDocker(images, containers);
  const app = await harness(docker); t.after(() => app.close());
  const res = await app.inject({ method: "POST", url: "/api/docker/images/prune", payload: { dryRun: true, mode: "unused", olderThanHours: 24 } });
  const ids = res.json().data.images.map((i: { id: string }) => i.id);
  assert.deepEqual(ids, [sha("b"), sha("d"), sha("f")], "c is too new; a and e are in use");
});

test("a real prune removes by ID, verifies with a fresh listing and reports failures", async (t) => {
  await setPermissions(ALL);
  const { images, containers } = sampleHost();
  const docker = fakeDocker(images, containers, { rmiFails: { [sha("d")]: "Error response from daemon: conflict: unable to remove repository reference" } });
  const app = await harness(docker); t.after(() => app.close());
  const res = await app.inject({ method: "POST", url: "/api/docker/images/prune", payload: { mode: "unused" } });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.equal(data.verified, true);
  assert.deepEqual(data.removed.map((i: { id: string }) => i.id).sort(), [sha("b"), sha("c"), sha("f")]);
  assert.equal(data.reclaimedBytes, 170);
  assert.equal(data.failed.length, 1);
  assert.equal(data.failed[0].id, sha("d"));
  assert.match(data.failed[0].error, /conflict/);
  const rmis = docker.calls.filter((c) => c[0] === "rmi");
  assert.deepEqual(rmis.find((c) => c.includes(sha("b"))), ["rmi", "--", sha("b")], "by ID, without --force");
  assert.deepEqual(rmis.find((c) => c.includes("ghcr.io/example/old:1")), ["rmi", "--", "ghcr.io/example/old:1", "ghcr.io/example/old:stable"], "a multi-tag image by its listed tags");
  assert.ok(!rmis.some((c) => c.includes(sha("a")) || c.includes(sha("e"))), "used images are never passed to rmi");
  assert.ok(!docker.calls.some((c) => c.includes("prune")), "docker image prune is never run");
  assert.ok(images.some((i) => i.id === sha("a")) && images.some((i) => i.id === sha("e")));
});

test("an image rmi says it removed but is still listed fails verification", async (t) => {
  await setPermissions(ALL);
  const { images, containers } = sampleHost();
  const app = await harness(fakeDocker(images, containers, { rmiNoop: [sha("b")] })); t.after(() => app.close());
  const res = await app.inject({ method: "POST", url: "/api/docker/images/prune", payload: {} });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "VERIFICATION_FAILED");
  assert.equal(res.json().data.verified, false);
});

// ── Update status ───────────────────────────────────────────────

test("update status joins Unraid's cache with containers and reports its age", async (t) => {
  await setPermissions(READ);
  const cache = join(root, "status.json");
  await copyFile(FIXTURE, cache);
  await utimes(cache, new Date("2026-10-17T06:00:00Z"), new Date("2026-10-17T06:00:00Z"));
  const containers: FakeContainer[] = [
    { id: cid("1"), name: "plex", imageId: sha("a"), image: "lscr.io/linuxserver/plex", state: "running" },
    { id: cid("2"), name: "web", imageId: sha("d"), image: "nginx", state: "exited" },
    { id: cid("3"), name: "private", imageId: sha("b"), image: "ghcr.io/example/private-app:1.2", state: "running" },
    { id: cid("4"), name: "new", imageId: sha("c"), image: "example/never-checked:2", state: "running" },
  ];
  const docker = fakeDocker([], containers);
  const app = await harness(docker, cache); t.after(() => app.close());
  const res = await app.inject({ method: "GET", url: "/api/docker/updates" });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.equal(data.cache.exists, true);
  assert.equal(data.cache.modifiedAt, "2026-10-17T06:00:00.000Z");
  assert.equal(data.cache.ageSeconds, 6 * 3600);
  assert.equal(data.cache.entries, 3, "a malformed entry is skipped, not fatal");
  const by = (n: string) => data.containers.find((c: { name: string }) => c.name === n);
  assert.equal(by("plex").updateAvailable, true);
  assert.equal(by("plex").cacheKey, "lscr.io/linuxserver/plex:latest");
  assert.equal(by("plex").remoteDigest, `sha256:${"2".repeat(64)}`);
  assert.equal(by("web").updateAvailable, false);
  assert.equal(by("web").cacheKey, "library/nginx:latest");
  assert.equal(by("web").state, "exited");
  assert.equal(by("private").updateAvailable, "unknown", "status undef is unknown");
  assert.equal(by("new").updateAvailable, "unknown", "no entry is unknown");
  assert.deepEqual(data.totals, { containers: 4, updatesAvailable: 1, upToDate: 1, unknown: 2 });
  assert.ok(docker.calls.every((c) => ["ps", "container"].includes(c[0])), "only listing commands run, no pull");
});

test("a missing, malformed or non-object cache makes every container unknown", async (t) => {
  await setPermissions(READ);
  const containers: FakeContainer[] = [{ id: cid("1"), name: "plex", imageId: sha("a"), image: "lscr.io/linuxserver/plex:latest", state: "running" }];
  const bad = join(root, "bad.json"); await writeFile(bad, "{not json");
  const list = join(root, "list.json"); await writeFile(list, "[1,2]");
  const empty = join(root, "empty.json"); await writeFile(empty, "[]");
  for (const [path, error] of [[join(root, "absent.json"), /does not exist/], [bad, /not valid JSON/], [list, /not a JSON object/], [empty, null]] as const) {
    const app = await harness(fakeDocker([], containers), path); t.after(() => app.close());
    const res = await app.inject({ method: "GET", url: "/api/docker/updates" });
    assert.equal(res.statusCode, 200, res.body);
    const data = res.json().data;
    if (error) assert.match(data.cache.error, error); else assert.equal(data.cache.error, undefined);
    assert.equal(data.containers[0].updateAvailable, "unknown");
  }
});

test("image keys follow Unraid's ensureImageTag", () => {
  assert.equal(unraidImageKey("nginx"), "library/nginx:latest");
  assert.equal(unraidImageKey("nginx:1.25"), "library/nginx:1.25");
  assert.equal(unraidImageKey("lscr.io/linuxserver/plex"), "lscr.io/linuxserver/plex:latest");
  assert.equal(unraidImageKey("localhost:5000/app"), "localhost:5000/app:latest");
  assert.equal(unraidImageKey("localhost:5000/app:2"), "localhost:5000/app:2");
});

// ── Tools ───────────────────────────────────────────────────────

test("the image tools call the routes they document and the prune tool re-checks its parameters", async () => {
  const { registerDockerTools } = await import("../../../openclaw-plugin/src/tools/docker.js");
  const tools = new Map<string, { parameters: Record<string, unknown>; execute: (id: string, p: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>();
  const calls: Array<[string, string, unknown]> = [];
  const client = {
    get: async (path: string) => { calls.push(["GET", path, undefined]); return {}; },
    post: async (path: string, body?: unknown) => { calls.push(["POST", path, body]); return {}; },
    patch: async () => ({}), delete: async () => ({}),
  };
  registerDockerTools({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never) }, () => client);
  await tools.get("unraid_docker_images")!.execute("1", {});
  await tools.get("unraid_docker_update_status")!.execute("1", {});
  await tools.get("unraid_docker_prune_images")!.execute("1", { dryRun: true, mode: "unused", olderThanHours: 48 });
  assert.deepEqual(calls, [
    ["GET", "/api/docker/images", undefined],
    ["GET", "/api/docker/updates", undefined],
    ["POST", "/api/docker/images/prune", { dryRun: true, mode: "unused", olderThanHours: 48 }],
  ]);
  assert.equal((tools.get("unraid_docker_prune_images")!.parameters as { additionalProperties?: boolean }).additionalProperties, false);
  for (const bad of [{ dryRun: "true" }, { mode: "all" }, { olderThanHours: -2 }, { extra: 1 }]) {
    const out = await tools.get("unraid_docker_prune_images")!.execute("1", bad);
    assert.match(out.content[0].text, /Error|must|Unknown/i, JSON.stringify(bad));
  }
  assert.equal(calls.length, 3, "refused parameters never reach HTTP");
});

test("an untagged image a plain listing hides is still listed and pruned", async (t) => {
  await setPermissions(ALL);
  const images: FakeImage[] = [
    { id: sha("a"), tags: ["decolua/9router:latest"], size: 300, created: "2026-10-23T00:00:00Z" },
    { id: sha("b"), tags: [], size: 280, created: "2026-10-01T00:00:00Z", hidden: true },
  ];
  const containers: FakeContainer[] = [
    { id: cid("1"), name: "9router", imageId: sha("a"), image: "decolua/9router", state: "running" },
  ];
  const app = await harness(fakeDocker(images, containers)); t.after(() => app.close());
  const list = await app.inject({ method: "GET", url: "/api/docker/images" });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().data.totals.danglingCount, 1);
  const res = await app.inject({ method: "POST", url: "/api/docker/images/prune", payload: { dryRun: false } });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.deepEqual(data.removed.map((i: { id: string }) => i.id), [sha("b")]);
  assert.equal(data.verified, true);
  assert.deepEqual(images.map((i) => i.id), [sha("a")]);
});
