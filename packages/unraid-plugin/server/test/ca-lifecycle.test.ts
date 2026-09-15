// Behavioural tests for updating and removing an installed Community
// Applications app.
//
// Everything runs against the real Fastify routes via app.inject(). Templates
// are real files in a temp directory, and docker is a small in-memory fake
// that records every argv it is given, so the update and remove paths are
// exercised end to end without a container, an image or a registry existing
// anywhere. Nothing here touches a real Unraid server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaRuntime } from "../src/routes/ca.js";
import { parseMemoryBytes } from "../src/ca-saved-template.js";

const flashBase = await mkdtemp(join(tmpdir(), "unraidclaw-lifecycle-"));
process.env.FLASH_BASE = flashBase;

const { loadPermissions } = await import("../src/config.js");
const { registerCaRoutes, createCaRuntime } = await import("../src/routes/ca.js");
const { CaFeed } = await import("../src/ca-feed.js");
const Fastify = (await import("fastify")).default;

const ALL_CA = { "ca:read": true, "ca:create": true, "ca:update": true, "ca:delete": true };

async function setPermissions(perms: Record<string, boolean>): Promise<void> {
  await writeFile(join(flashBase, "permissions.json"), JSON.stringify(perms), "utf8");
  loadPermissions();
}

// ── A fake docker ───────────────────────────────────────────────

interface FakeImage {
  id: string;
  entrypoint?: string[] | null;
  cmd?: string[] | null;
  user?: string;
  workingDir?: string;
}

interface FakeContainer {
  id: string;
  name: string;
  /** The image reference it was created from. */
  image: string;
  imageId: string;
  running: boolean;
  labels: Record<string, string>;
  restart?: string;
  pidsLimit?: number;
  mounts?: Array<Record<string, unknown>>;
  /** Overrides merged into the inspect output, for the divergence tests. */
  config?: Record<string, unknown>;
  hostConfig?: Record<string, unknown>;
  networks?: string[];
  networkMode?: string;
  /** State.Status, when it is not derived from `running`. */
  status?: string;
  paused?: boolean;
}

class FakeDocker {
  images = new Map<string, FakeImage>();
  tags = new Map<string, string>();
  containers: FakeContainer[] = [];
  /** Every argv this fake was asked to run, in order. */
  runs: string[][] = [];
  /** Commands that should fail once, keyed by the docker subcommand. */
  failures: Record<string, string> = {};
  /** Commands that should fail every time they are tried. */
  alwaysFail: Record<string, string> = {};
  /** Image id `docker pull` should install for the tag it is given. */
  pullsTo: string | null = null;
  /** Set when anything asks docker to delete a volume. Must never happen. */
  volumesRemoved = false;
  /** Set when anything asks docker to delete an image. Must never happen. */
  imagesRemoved = false;
  /** Awaited before `docker pull` answers, for the concurrency test. */
  gate: Promise<void> | null = null;

  private seq = 0;

  addImage(ref: string, image: FakeImage): void {
    this.images.set(image.id, image);
    this.tags.set(ref, image.id);
  }

  addContainer(c: Omit<FakeContainer, "id"> & { id?: string }): FakeContainer {
    const full = { id: c.id ?? `sha256:c${++this.seq}`, ...c } as FakeContainer;
    this.containers.push(full);
    return full;
  }

  byRef(ref: string): FakeContainer | undefined {
    return this.containers.find((c) => c.name === ref || c.id === ref);
  }

  imageOf(ref: string): FakeImage | undefined {
    const id = this.tags.get(ref) ?? ref;
    return this.images.get(id);
  }

  /** The argv of every mutating call, i.e. everything but an inspect. */
  mutations(): string[][] {
    return this.runs.filter((r) => r[1] !== "inspect" && !(r[1] === "image" && r[2] === "inspect"));
  }

  private containerJson(c: FakeContainer): Record<string, unknown> {
    const img = this.images.get(c.imageId);
    return {
      Id: c.id,
      Name: `/${c.name}`,
      Image: c.imageId,
      State: {
        Status: c.status ?? (c.paused ? "paused" : c.running ? "running" : "exited"),
        Running: c.running,
        Paused: c.paused === true,
        Restarting: c.status === "restarting",
        Dead: c.status === "dead",
      },
      Config: {
        Image: c.image,
        Labels: c.labels,
        Entrypoint: img?.entrypoint ?? null,
        Cmd: img?.cmd ?? null,
        User: img?.user ?? "",
        WorkingDir: img?.workingDir ?? "",
        ...(c.config ?? {}),
      },
      // The full default shape docker reports for an Unraid container, so the
      // blocker checks are exercised against realistic input rather than the
      // handful of fields they happen to read.
      HostConfig: {
        Binds: (c.mounts ?? []).filter((m) => m.Type === "bind").map((m) => `${m.Source}:${m.Destination}:rw`),
        ContainerIDFile: "",
        LogConfig: { Type: "json-file", Config: {} },
        NetworkMode: c.networkMode ?? "bridge",
        PortBindings: {},
        RestartPolicy: { Name: c.restart ?? "no", MaximumRetryCount: 0 },
        AutoRemove: false,
        VolumeDriver: "",
        VolumesFrom: null,
        ConsoleSize: [0, 0],
        CapAdd: null,
        CapDrop: null,
        CgroupnsMode: "host",
        Dns: [],
        DnsOptions: [],
        DnsSearch: [],
        ExtraHosts: null,
        GroupAdd: null,
        IpcMode: "private",
        Cgroup: "",
        Links: null,
        OomScoreAdj: 0,
        PidMode: "",
        Privileged: false,
        PublishAllPorts: false,
        ReadonlyRootfs: false,
        SecurityOpt: null,
        UTSMode: "",
        UsernsMode: "",
        ShmSize: 67108864,
        Runtime: "runc",
        Isolation: "",
        CpuShares: 0,
        Memory: 0,
        NanoCpus: 0,
        CgroupParent: "",
        BlkioWeight: 0,
        CpuPeriod: 0,
        CpuQuota: 0,
        CpusetCpus: "",
        CpusetMems: "",
        Devices: [],
        DeviceCgroupRules: null,
        DeviceRequests: null,
        MemoryReservation: 0,
        MemorySwap: 0,
        MemorySwappiness: null,
        OomKillDisable: false,
        PidsLimit: c.pidsLimit ?? 0,
        Ulimits: null,
        Sysctls: {},
        MaskedPaths: ["/proc/asound", "/proc/acpi", "/proc/kcore"],
        ReadonlyPaths: ["/proc/bus", "/proc/fs", "/proc/irq"],
        ...(c.hostConfig ?? {}),
      },
      Mounts: c.mounts ?? [],
      NetworkSettings: {
        Networks: Object.fromEntries((c.networks ?? ["bridge"]).map((n) => [n, {}])),
      },
    };
  }

  run = async (file: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    this.runs.push([file, ...args]);
    if (file !== "docker") throw new Error(`the fake was asked to run ${file}`);
    const cmd = args[0];
    // A one-shot failure is consumed when it fires, so a retry or a rollback
    // sees the world as it would be after the condition cleared.
    const fail = (key: string) => {
      if (this.alwaysFail[key]) throw new Error(this.alwaysFail[key]);
      const message = this.failures[key];
      if (message) {
        delete this.failures[key];
        throw new Error(message);
      }
    };

    if (cmd === "inspect") {
      const ref = args[args.length - 1];
      const c = this.byRef(ref);
      if (!c) throw new Error(`Error: No such container: ${ref}`);
      return { stdout: `${JSON.stringify(this.containerJson(c))}\n`, stderr: "" };
    }

    if (cmd === "image" && args[1] === "inspect") {
      const ref = args[args.length - 1];
      const img = this.imageOf(ref);
      if (!img) throw new Error(`Error: No such image: ${ref}`);
      return {
        stdout: `${JSON.stringify({
          Id: img.id,
          Config: {
            Entrypoint: img.entrypoint ?? null,
            Cmd: img.cmd ?? null,
            User: img.user ?? "",
            WorkingDir: img.workingDir ?? "",
          },
        })}\n`,
        stderr: "",
      };
    }

    if (cmd === "pull") {
      if (this.gate) await this.gate;
      fail("pull");
      if (this.pullsTo) {
        this.images.set(this.pullsTo, { id: this.pullsTo });
        this.tags.set(args[1], this.pullsTo);
      }
      return { stdout: "", stderr: "" };
    }

    if (cmd === "create") {
      fail("create");
      const name = args[args.indexOf("--name") + 1];
      const image = args[args.length - 1];
      const img = this.imageOf(image);
      if (!img) throw new Error(`Unable to find image '${image}'`);
      if (this.byRef(name)) throw new Error(`Conflict. The container name "/${name}" is already in use`);
      const labels: Record<string, string> = {};
      const mounts: Array<Record<string, unknown>> = [];
      const hostConfig: Record<string, unknown> = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--memory") {
          // What docker records for --memory alone: swap is twice the limit.
          const bytes = parseMemoryBytes(args[i + 1]) ?? 0;
          hostConfig.Memory = bytes;
          hostConfig.MemorySwap = bytes * 2;
        }
        if (args[i] === "-l") {
          const [k, ...rest] = args[i + 1].split("=");
          labels[k] = rest.join("=");
        }
        if (args[i] === "-v") {
          const [source, destination] = args[i + 1].split(":");
          mounts.push({ Type: source.startsWith("/") ? "bind" : "volume", Source: source, Name: source, Destination: destination });
        }
      }
      const created = this.addContainer({ name, image, imageId: img.id, running: false, labels, mounts, hostConfig });
      return { stdout: `${created.id}\n`, stderr: "" };
    }

    if (cmd === "stop" || cmd === "start" || cmd === "rename" || cmd === "rm") {
      const ref = cmd === "rm" ? args[args.length - 1] : args[1];
      const c = this.byRef(ref);
      if (!c) throw new Error(`Error: No such container: ${ref}`);
      fail(cmd);
      if (cmd === "stop") c.running = false;
      if (cmd === "start") c.running = true;
      if (cmd === "rename") c.name = args[2];
      if (cmd === "rm") {
        if (args.includes("-v") || args.includes("--volumes")) this.volumesRemoved = true;
        this.containers = this.containers.filter((x) => x !== c);
      }
      return { stdout: "", stderr: "" };
    }

    if (cmd === "rmi" || (cmd === "image" && args[1] === "rm")) {
      this.imagesRemoved = true;
      return { stdout: "", stderr: "" };
    }

    throw new Error(`the fake does not implement "docker ${args.join(" ")}"`);
  };
}

// ── Templates ───────────────────────────────────────────────────

interface TemplateSpec {
  name: string;
  image: string;
  network?: string;
  webui?: string;
  icon?: string;
  extra?: string;
  configs?: Array<{
    label?: string;
    target: string;
    type: string;
    mode?: string;
    value: string;
    fallback?: string;
    mask?: boolean;
  }>;
}

function templateXml(spec: TemplateSpec): string {
  const configs = (spec.configs ?? [])
    .map(
      (c) =>
        `  <Config Name="${c.label ?? c.target}" Target="${c.target}" Default="${c.fallback ?? c.value}" Mode="${c.mode ?? ""}" Description="" Type="${c.type}" Display="always" Required="false" Mask="${c.mask ? "true" : "false"}">${c.value}</Config>`
    )
    .join("\n");
  return `<?xml version="1.0"?>
<Container version="2">
  <Name>${spec.name}</Name>
  <Repository>${spec.image}</Repository>
  <Registry/>
  <Network>${spec.network ?? "bridge"}</Network>
  <MyIP/>
  <Shell>sh</Shell>
  <Privileged>false</Privileged>
  <Support/>
  <Overview>An app.</Overview>
  <WebUI>${spec.webui ?? ""}</WebUI>
  <Icon>${spec.icon ?? ""}</Icon>
  <ExtraParams/>
  <PostArgs/>
  <CPUset/>
  <DateInstalled>1700000000</DateInstalled>
${spec.extra ?? ""}
${configs}
</Container>`;
}

/** The app every test starts from: a running Jellyfin with user-chosen values. */
const JELLYFIN_SPEC: TemplateSpec = {
  name: "jellyfin",
  image: "jellyfin/jellyfin:latest",
  webui: "http://[IP]:[PORT:8096]/",
  icon: "https://example.invalid/jellyfin.png",
  configs: [
    { label: "WebUI", target: "8096", type: "Port", mode: "tcp", value: "18096", fallback: "8096" },
    { label: "Config", target: "/config", type: "Path", mode: "rw", value: "/mnt/user/appdata/jellyfin-custom", fallback: "/mnt/user/appdata/jellyfin" },
    { label: "PUID", target: "PUID", type: "Variable", value: "1000", fallback: "99" },
  ],
};
const JELLYFIN = templateXml(JELLYFIN_SPEC);

/** The Jellyfin template as Unraid 7.4 saves it, with its new elements. */
const jellyfin74 = (memory: string, extraNetworks = "") =>
  templateXml({ ...JELLYFIN_SPEC, extra: `  <ExtraNetworks>${extraNetworks}</ExtraNetworks>\n  <Memory>${memory}</Memory>` });

interface Harness {
  app: ReturnType<typeof Fastify>;
  docker: FakeDocker;
  templatesDir: string;
}

async function harness(
  docker: FakeDocker,
  templates: Record<string, string> = { "my-jellyfin.xml": JELLYFIN },
  overrides: Partial<CaRuntime> = {}
): Promise<Harness> {
  const templatesDir = join(await mkdtemp(join(tmpdir(), "unraidclaw-tmpl-")), "templates-user");
  await mkdir(templatesDir, { recursive: true });
  for (const [file, xml] of Object.entries(templates)) {
    await writeFile(join(templatesDir, file), xml, "utf8");
  }

  const runtime = createCaRuntime({
    // Update and remove must never consult the catalog: everything they need
    // is in the saved template. A fetch here fails the test.
    feed: new CaFeed({
      fetchImpl: (async () => {
        throw new Error("the lifecycle routes must not fetch the CA catalog");
      }) as unknown as typeof fetch,
    }),
    templatesDir,
    run: docker.run,
    readHostVars: async () => ({ timeZone: "Europe/Rome", hostName: "Tower" }),
    ...overrides,
  });

  const app = Fastify();
  registerCaRoutes(app, runtime);
  await app.ready();
  return { app, docker, templatesDir };
}

/** A fake holding a running jellyfin on image sha256:old. */
function runningJellyfin(extra: Partial<FakeContainer> = {}): FakeDocker {
  const docker = new FakeDocker();
  docker.addImage("jellyfin/jellyfin:latest", { id: "sha256:old" });
  docker.addContainer({
    id: "sha256:container-old",
    name: "jellyfin",
    image: "jellyfin/jellyfin:latest",
    imageId: "sha256:old",
    running: true,
    labels: { "net.unraid.docker.managed": "dockerman" },
    mounts: [
      { Type: "bind", Source: "/mnt/user/appdata/jellyfin-custom", Destination: "/config" },
      { Type: "volume", Name: "jellyfin-cache", Destination: "/cache" },
    ],
    restart: "unless-stopped",
    pidsLimit: 2048,
    ...extra,
  });
  docker.pullsTo = "sha256:new";
  return docker;
}

const post = (app: Harness["app"], url: string, payload: unknown = {}) =>
  app.inject({ method: "POST", url, payload: payload as object, headers: { "content-type": "application/json" } });

// ── Permissions ─────────────────────────────────────────────────

test("update is refused without ca:update, even with ca:read and ca:create", async () => {
  await setPermissions({ "ca:read": true, "ca:create": true });
  const { app, docker } = await harness(runningJellyfin());
  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 403);
  assert.deepEqual(docker.runs, [], "nothing was run");
});

test("remove is refused without ca:delete, even with ca:update", async () => {
  await setPermissions({ "ca:read": true, "ca:update": true });
  const { app, docker } = await harness(runningJellyfin());
  const res = await post(app, "/api/ca/app/jellyfin/remove");
  assert.equal(res.statusCode, 403);
  assert.deepEqual(docker.runs, [], "nothing was run");
});

test("ca:update and ca:delete are off in a default permission file", async () => {
  await setPermissions({});
  const { app } = await harness(runningJellyfin());
  assert.equal((await post(app, "/api/ca/app/jellyfin/update")).statusCode, 403);
  assert.equal((await post(app, "/api/ca/app/jellyfin/remove")).statusCode, 403);
});

// ── Dry runs ────────────────────────────────────────────────────

test("an update dry run reports the saved configuration and changes nothing", async () => {
  await setPermissions(ALL_CA);
  const { app, docker } = await harness(runningJellyfin());
  const res = await post(app, "/api/ca/app/jellyfin/update", { dryRun: true });

  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.dryRun, true);
  assert.equal(data.updated, false);
  assert.equal(data.wasRunning, true);
  assert.equal(data.previousImageId, "sha256:old");
  // The user's own values, not the template's catalog defaults.
  assert.deepEqual(data.plan.ports, ["18096:8096/tcp"]);
  assert.deepEqual(data.plan.volumes, [
    "/mnt/user/appdata/jellyfin-custom:/config:rw",
    // The container's own volume, which the template says nothing about.
    "jellyfin-cache:/cache:rw",
  ]);
  assert.deepEqual(data.plan.env, ["PUID=1000"]);
  assert.ok(data.plan.dockerCommand.includes("-e"));
  assert.ok(data.plan.dockerCommand.includes("TZ=Europe/Rome"));
  assert.ok(data.plan.dockerCommand.includes("HOST_CONTAINERNAME=jellyfin"));
  assert.ok(data.plan.dockerCommand.includes("net.unraid.docker.managed=dockerman"));
  assert.deepEqual(docker.mutations(), [], "a dry run runs no mutating docker command");
});

test("a remove dry run lists what would survive and changes nothing", async () => {
  await setPermissions(ALL_CA);
  const { app, docker, templatesDir } = await harness(runningJellyfin());
  const res = await post(app, "/api/ca/app/jellyfin/remove", { dryRun: true });

  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.dryRun, true);
  assert.equal(data.removed, false);
  assert.equal(data.preserved.templatePath, join(templatesDir, "my-jellyfin.xml"));
  assert.deepEqual(data.preserved.volumes, ["jellyfin-cache"]);
  assert.deepEqual(data.preserved.hostPaths, ["/mnt/user/appdata/jellyfin-custom"]);
  assert.deepEqual(docker.mutations(), []);
  assert.equal(docker.byRef("jellyfin")?.running, true);
});

test("a mistyped dryRun is refused before anything runs", async () => {
  await setPermissions(ALL_CA);
  const { app, docker } = await harness(runningJellyfin());
  for (const url of ["/api/ca/app/jellyfin/update", "/api/ca/app/jellyfin/remove"]) {
    const res = await post(app, url, { dryrun: true });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /dryRun/);
  }
  assert.deepEqual(docker.runs, []);
});

test("a string dryRun is refused rather than coerced", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness(runningJellyfin());
  const res = await post(app, "/api/ca/app/jellyfin/update", { dryRun: "false" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "CA_INVALID_BODY");
});

// ── Targeting ───────────────────────────────────────────────────

test("an unknown container is a 404 that explains the name is the container's", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness(runningJellyfin());
  const res = await post(app, "/api/ca/app/Jellyfin/update", { dryRun: true });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, "CA_CONTAINER_NOT_FOUND");
  assert.match(res.json().error.message, /installed container/i);
});

test("a container with no saved template is refused", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness(runningJellyfin(), {});
  const res = await post(app, "/api/ca/app/jellyfin/remove", { dryRun: true });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, "CA_TEMPLATE_NOT_FOUND");
});

test("a template naming a different container is refused", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness(runningJellyfin(), {
    "my-jellyfin.xml": templateXml({ name: "jellyfin-old", image: "jellyfin/jellyfin:latest" }),
  });
  const res = await post(app, "/api/ca/app/jellyfin/update", { dryRun: true });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "CA_TEMPLATE_MISMATCH");
});

test("a template for a different image is refused", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness(runningJellyfin(), {
    "my-jellyfin.xml": templateXml({ name: "jellyfin", image: "linuxserver/jellyfin:latest" }),
  });
  const res = await post(app, "/api/ca/app/jellyfin/remove", { dryRun: true });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "CA_TEMPLATE_MISMATCH");
});

test("an equivalent image reference is not treated as a mismatch", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness(runningJellyfin(), {
    "my-jellyfin.xml": JELLYFIN.replace("jellyfin/jellyfin:latest", "docker.io/jellyfin/jellyfin"),
  });
  const res = await post(app, "/api/ca/app/jellyfin/update", { dryRun: true });
  assert.equal(res.statusCode, 200);
});

test("a container Unraid's docker manager did not create is refused", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin({ labels: {} });
  const { app } = await harness(docker);
  const res = await post(app, "/api/ca/app/jellyfin/remove", { dryRun: true });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "CA_NOT_MANAGED");
});

test("two templates matching one container are refused rather than guessed", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness(runningJellyfin(), {
    "my-jellyfin.xml": JELLYFIN,
    "my-Jellyfin.xml": JELLYFIN,
  });
  const res = await post(app, "/api/ca/app/jellyfin/update", { dryRun: true });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "CA_TEMPLATE_AMBIGUOUS");
});

// ── Refusals ────────────────────────────────────────────────────

test("a saved template with Extra Parameters is refused", async () => {
  await setPermissions(ALL_CA);
  const { app, docker } = await harness(runningJellyfin(), {
    "my-jellyfin.xml": templateXml({
      name: "jellyfin",
      image: "jellyfin/jellyfin:latest",
      extra: "  <ExtraParams>--device=/dev/dri</ExtraParams>",
    }),
  });
  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "CA_NOT_UPDATABLE");
  assert.ok(res.json().error.details.blockers.some((b: { code: string }) => b.code === "CA_EXTRA_PARAMS"));
  assert.deepEqual(docker.mutations(), [], "a refused update pulls nothing");
});

test("a saved template passing a host device through is refused", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness(runningJellyfin(), {
    "my-jellyfin.xml": templateXml({
      name: "jellyfin",
      image: "jellyfin/jellyfin:latest",
      configs: [{ label: "GPU", target: "/dev/dri", type: "Device", value: "/dev/dri" }],
    }),
  });
  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 422);
  assert.ok(res.json().error.details.blockers.some((b: { code: string }) => b.code === "CA_DEVICE_PASSTHROUGH"));
});

test("an element the template parser does not understand is refused, not dropped", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness(runningJellyfin(), {
    "my-jellyfin.xml": templateXml({
      name: "jellyfin",
      image: "jellyfin/jellyfin:latest",
      extra: "  <GpuMagic>on</GpuMagic>",
    }),
  });
  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 422);
  assert.ok(
    res.json().error.details.blockers.some((b: { code: string }) => b.code === "CA_UNSUPPORTED_TEMPLATE_FIELD")
  );
});

test("a template that is not XML is refused", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness(runningJellyfin(), { "my-jellyfin.xml": "<Container><Name>jellyfin</Name>" });
  const res = await post(app, "/api/ca/app/jellyfin/update", { dryRun: true });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "CA_TEMPLATE_UNREADABLE");
});

test("a template carrying a DOCTYPE is refused before it is parsed", async () => {
  await setPermissions(ALL_CA);
  const { app } = await harness(runningJellyfin(), {
    "my-jellyfin.xml": `<?xml version="1.0"?><!DOCTYPE Container [<!ENTITY x "y">]>\n${JELLYFIN.replace(/^<\?xml[^>]*\?>/, "")}`,
  });
  const res = await post(app, "/api/ca/app/jellyfin/update", { dryRun: true });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "CA_TEMPLATE_UNREADABLE");
});

test("a container running with host devices the template does not describe is refused", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin({ hostConfig: { Devices: [{ PathOnHost: "/dev/dri" }] } });
  const { app } = await harness(docker);
  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 422);
  assert.ok(res.json().error.details.blockers.some((b: { code: string }) => b.code === "CA_LIVE_DEVICES"));
  assert.deepEqual(docker.mutations(), []);
});

test("a container with an overridden entrypoint is refused", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin({ config: { Entrypoint: ["/custom.sh"] } });
  const { app } = await harness(docker);
  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 422);
  assert.ok(res.json().error.details.blockers.some((b: { code: string }) => b.code === "CA_LIVE_ENTRYPOINT"));
});

// ── Updating ────────────────────────────────────────────────────

test("a failed pull leaves the running container and its image untouched", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  docker.failures.pull = "manifest unknown";
  const { app } = await harness(docker);

  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error.code, "CA_PULL_FAILED");
  assert.deepEqual(docker.mutations().map((r) => r[1]), ["pull"], "the pull is the only thing attempted");
  const c = docker.byRef("jellyfin");
  assert.equal(c?.running, true);
  assert.equal(c?.imageId, "sha256:old");
  assert.ok(docker.images.has("sha256:old"));
});

test("an image that is already current is reported, not recreated", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  docker.pullsTo = "sha256:old";
  const { app } = await harness(docker);

  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.updated, false);
  assert.equal(data.imageId, "sha256:old");
  assert.match(data.warnings.join(" "), /already the image/);
  assert.deepEqual(docker.mutations().map((r) => r[1]), ["pull"]);
  assert.equal(docker.byRef("jellyfin")?.id, "sha256:container-old");
});

test("a running app is updated in place and comes back running", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  const { app, templatesDir } = await harness(docker);
  const before = await readFile(join(templatesDir, "my-jellyfin.xml"), "utf8");

  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.updated, true);
  assert.equal(data.previousImageId, "sha256:old");
  assert.equal(data.imageId, "sha256:new");
  assert.equal(data.running, true);

  const live = docker.containers.filter((c) => c.name.startsWith("jellyfin"));
  assert.equal(live.length, 1, "exactly one container is left");
  assert.equal(live[0].name, "jellyfin");
  assert.equal(live[0].imageId, "sha256:new");
  assert.equal(live[0].running, true);
  assert.equal(live[0].id, data.containerId);
  assert.notEqual(live[0].id, "sha256:container-old");

  // The user's configuration came from the template, not from the catalog.
  const created = docker.runs.find((r) => r[1] === "create")!;
  assert.ok(created.includes("18096:8096/tcp"));
  assert.ok(created.includes("/mnt/user/appdata/jellyfin-custom:/config:rw"));
  assert.ok(created.includes("PUID=1000"));
  assert.ok(created.includes("unless-stopped"), "the restart policy is carried over");
  assert.ok(created.includes("2048"), "the pids limit is carried over");

  // Nothing was deleted but the old container.
  assert.equal(docker.volumesRemoved, false);
  assert.equal(docker.imagesRemoved, false);
  assert.ok(docker.images.has("sha256:old"), "the previous image is still on the server");
  assert.equal(await readFile(join(templatesDir, "my-jellyfin.xml"), "utf8"), before, "the template is untouched");
});

test("an app that was stopped stays stopped after an update", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin({ running: false });
  const { app } = await harness(docker);

  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.running, false);
  assert.equal(res.json().data.wasRunning, false);
  assert.equal(docker.byRef("jellyfin")?.running, false);
  assert.ok(!docker.mutations().some((r) => r[1] === "start"), "a stopped app is not started");
  assert.ok(!docker.mutations().some((r) => r[1] === "stop"), "a stopped app is not stopped again");
});

test("a container that cannot be created leaves the old one running", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  docker.failures.create = "port is already allocated";
  const { app } = await harness(docker);

  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "CA_CREATE_FAILED");
  assert.match(res.json().error.message, /still running/);
  const c = docker.byRef("jellyfin");
  assert.equal(c?.id, "sha256:container-old");
  assert.equal(c?.running, true);
  assert.ok(!docker.mutations().some((r) => r[1] === "rename"), "nothing was renamed");
});

test("a replacement that will not start is rolled back to the previous container", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  docker.failures.start = "driver failed programming external connectivity";
  const { app } = await harness(docker);

  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "CA_START_FAILED");

  const live = docker.containers.filter((c) => c.name.startsWith("jellyfin"));
  assert.equal(live.length, 1, "the replacement was discarded");
  assert.equal(live[0].id, "sha256:container-old", "the original container is back");
  assert.equal(live[0].name, "jellyfin");
  assert.equal(live[0].imageId, "sha256:old");
  assert.equal(docker.imagesRemoved, false);
});

test("a rollback that itself fails is reported as needing attention, not as success", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  docker.alwaysFail.start = "device or resource busy";
  const { app } = await harness(docker);

  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 500);
  const { error } = res.json();
  assert.equal(error.code, "CA_UPDATE_INCOMPLETE");
  assert.match(error.message, /could not be restarted/);
  assert.equal(error.details.containerId, "sha256:container-old");
  // The original container is back under its own name, stopped, and nothing
  // was deleted beyond the replacement that never worked.
  const live = docker.containers.filter((c) => c.name.startsWith("jellyfin"));
  assert.equal(live.length, 1);
  assert.equal(live[0].id, "sha256:container-old");
  assert.equal(live[0].name, "jellyfin");
  assert.equal(live[0].running, false);
  assert.equal(docker.imagesRemoved, false);
  assert.equal(docker.volumesRemoved, false);
});

test("leftovers from an interrupted update stop a new one", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  docker.addContainer({
    name: "jellyfin.unraidclaw-old",
    image: "jellyfin/jellyfin:latest",
    imageId: "sha256:old",
    running: false,
    labels: { "net.unraid.docker.managed": "dockerman" },
  });
  const { app } = await harness(docker);

  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "CA_LEFTOVER_CONTAINER");
  assert.ok(!docker.mutations().some((r) => r[1] === "create"));
});

// ── Removing ────────────────────────────────────────────────────

test("removing stops the app, removes only the container, and keeps everything else", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  const { app, templatesDir } = await harness(docker);

  const res = await post(app, "/api/ca/app/jellyfin/remove");
  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.removed, true);
  assert.equal(data.containerId, "sha256:container-old");
  assert.equal(data.preserved.imageId, "sha256:old");

  assert.equal(docker.byRef("jellyfin"), undefined, "the container is gone");
  assert.deepEqual(docker.mutations().map((r) => r.slice(1, 2).concat(r.slice(-1))), [
    ["stop", "sha256:container-old"],
    ["rm", "sha256:container-old"],
  ]);
  assert.equal(docker.volumesRemoved, false, "docker rm was called without -v");
  assert.equal(docker.imagesRemoved, false);
  assert.ok(docker.images.has("sha256:old"));
  assert.deepEqual(await readdir(templatesDir), ["my-jellyfin.xml"], "the saved template is kept");
});

test("a stopped app is removed without being stopped again", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin({ running: false });
  const { app } = await harness(docker);

  const res = await post(app, "/api/ca/app/jellyfin/remove");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(docker.mutations().map((r) => r[1]), ["rm"]);
});

test("a container that will not stop is not removed", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  docker.failures.stop = "permission denied";
  const { app } = await harness(docker);

  const res = await post(app, "/api/ca/app/jellyfin/remove");
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "CA_STOP_FAILED");
  assert.match(res.json().error.message, /Nothing was removed/);
  assert.ok(docker.byRef("jellyfin"));
});

// ── Concurrency ─────────────────────────────────────────────────

test("a second lifecycle action on the same app is refused while one is running", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  let release = () => {};
  docker.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app } = await harness(docker);

  const update = post(app, "/api/ca/app/jellyfin/update");
  // Let the update reach its pull, which is holding on the gate.
  await new Promise((r) => setTimeout(r, 20));

  const remove = await post(app, "/api/ca/app/jellyfin/remove");
  assert.equal(remove.statusCode, 409);
  assert.equal(remove.json().error.code, "CA_ACTION_IN_FLIGHT");
  assert.match(remove.json().error.message, /update/);

  release();
  assert.equal((await update).statusCode, 200);

  // The claim is released again once the update finishes.
  const after = await post(app, "/api/ca/app/jellyfin/remove", { dryRun: true });
  assert.equal(after.statusCode, 200);
});

// ── Keeping what the container already has ──────────────────────

test("volumes the template does not mention are reattached, not recreated empty", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin({
    mounts: [
      { Type: "bind", Source: "/mnt/user/appdata/jellyfin-custom", Destination: "/config" },
      { Type: "volume", Name: "jellyfin-cache", Destination: "/cache" },
      // An anonymous volume, the kind docker creates from the image's own
      // VOLUME instruction. Its name is its id.
      { Type: "volume", Name: "9f2b1c".repeat(10) + "abcd", Destination: "/var/lib/data", RW: true },
    ],
  });
  const { app } = await harness(docker);

  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 200);

  const created = docker.runs.find((r) => r[1] === "create")!;
  assert.ok(created.includes("jellyfin-cache:/cache:rw"), "the named volume is reattached by name");
  assert.ok(
    created.includes(`${"9f2b1c".repeat(10)}abcd:/var/lib/data:rw`),
    "the anonymous volume is reattached by id"
  );
  // The template's own path is passed once, from the template.
  assert.equal(created.filter((a) => a.endsWith(":/config:rw")).length, 1);

  const newContainer = docker.byRef("jellyfin")!;
  assert.deepEqual(
    newContainer.mounts?.map((m) => m.Destination).sort(),
    ["/cache", "/config", "/var/lib/data"]
  );
  assert.equal(docker.volumesRemoved, false, "no rm touched a volume");
  assert.ok(!docker.runs.some((r) => r[1] === "volume"), "no volume command was run at all");
});

test("a read-only volume is reattached read-only", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin({
    mounts: [{ Type: "volume", Name: "shared-media", Destination: "/media", RW: false }],
  });
  const { app } = await harness(docker);
  assert.equal((await post(app, "/api/ca/app/jellyfin/update")).statusCode, 200);
  assert.ok(docker.runs.find((r) => r[1] === "create")!.includes("shared-media:/media:ro"));
});

test("a bind mount the template does not describe is refused, not dropped", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin({
    mounts: [{ Type: "bind", Source: "/mnt/user/secret", Destination: "/secret" }],
  });
  const { app } = await harness(docker);
  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 422);
  assert.ok(res.json().error.details.blockers.some((b: { code: string }) => b.code === "CA_LIVE_MOUNT_UNSUPPORTED"));
  assert.deepEqual(docker.mutations(), []);
});

test("resource limits and a read-only root are refusals rather than silent losses", async () => {
  await setPermissions(ALL_CA);
  for (const [field, value, code] of [
    ["Memory", 2147483648, "CA_LIVE_MEMORY_LIMIT"],
    ["NanoCpus", 2000000000, "CA_LIVE_CPU_LIMIT"],
    ["CpusetCpus", "0-3", "CA_LIVE_CPUSET"],
    ["ReadonlyRootfs", true, "CA_LIVE_READONLY_ROOTFS"],
    ["Dns", ["1.1.1.1"], "CA_LIVE_DNS"],
    ["Tmpfs", { "/run": "" }, "CA_LIVE_TMPFS"],
    ["PidMode", "host", "CA_LIVE_NAMESPACE"],
    ["NetworkMode", "br0", "CA_LIVE_NETWORK_MISMATCH"],
  ] as const) {
    const docker = runningJellyfin({ hostConfig: { [field]: value } });
    const { app } = await harness(docker);
    const res = await post(app, "/api/ca/app/jellyfin/update");
    assert.equal(res.statusCode, 422, `${field} should be refused`);
    assert.ok(
      res.json().error.details.blockers.some((b: { code: string }) => b.code === code),
      `${field} should report ${code}`
    );
    assert.deepEqual(docker.mutations(), [], `${field} should change nothing`);
  }
});

test("memory sizes are read the way docker reads --memory", () => {
  for (const [value, bytes] of [
    ["512m", 536870912],
    ["2g", 2147483648],
    ["2G", 2147483648],
    ["1.5g", 1610612736],
    ["2gb", 2147483648],
    ["2GiB", 2147483648],
    ["2 g", 2147483648],
    ["7.m", 7340032],
    ["8000000b", 8000000],
    ["1073741824", 1073741824],
    ["0", 0],
  ] as const) {
    assert.equal(parseMemoryBytes(value), bytes, value);
  }
  for (const value of ["-1", "abc", "2x", "g", "", "2 gb extra", "2  g", "8mI", "8000000ib", "8000000i"]) {
    assert.equal(parseMemoryBytes(value), null, value);
  }
});

test("an Unraid 7.4 template with its new elements left empty updates normally", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  const { app } = await harness(docker, { "my-jellyfin.xml": jellyfin74("") });
  assert.equal((await post(app, "/api/ca/app/jellyfin/update")).statusCode, 200);
  assert.ok(!docker.runs.find((r) => r[1] === "create")!.includes("--memory"));
});

test("a memory limit the saved template sets is reproduced", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin({ hostConfig: { Memory: 2147483648, MemorySwap: 4294967296 } });
  const { app } = await harness(docker, { "my-jellyfin.xml": jellyfin74("2g") });
  assert.equal((await post(app, "/api/ca/app/jellyfin/update")).statusCode, 200);
  const create = docker.runs.find((r) => r[1] === "create")!;
  assert.equal(create[create.indexOf("--memory") + 1], "2g");
});

test("a memory limit that differs from the saved template is refused", async () => {
  await setPermissions(ALL_CA);
  for (const hostConfig of [
    {},
    { Memory: 1073741824, MemorySwap: 2147483648 },
    { Memory: 2147483648, MemorySwap: -1 },
  ]) {
    const docker = runningJellyfin({ hostConfig });
    const { app } = await harness(docker, { "my-jellyfin.xml": jellyfin74("2g") });
    const res = await post(app, "/api/ca/app/jellyfin/update");
    assert.equal(res.statusCode, 422, JSON.stringify(hostConfig));
    assert.ok(res.json().error.details.blockers.some((b: { code: string }) => b.code === "CA_LIVE_MEMORY_LIMIT"));
    assert.deepEqual(docker.mutations(), []);
  }
});

test("a memory limit docker would reject is refused", async () => {
  await setPermissions(ALL_CA);
  for (const memory of ["lots", "1m"]) {
    const docker = runningJellyfin();
    const { app } = await harness(docker, { "my-jellyfin.xml": jellyfin74(memory) });
    const res = await post(app, "/api/ca/app/jellyfin/update");
    assert.equal(res.statusCode, 422, memory);
    assert.ok(res.json().error.details.blockers.some((b: { code: string }) => b.code === "CA_INVALID_MEMORY"));
    assert.deepEqual(docker.mutations(), []);
  }
});

test("a saved template with Additional Networks is refused, not dropped", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  const { app } = await harness(docker, { "my-jellyfin.xml": jellyfin74("", "proxy") });
  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 422);
  assert.ok(res.json().error.details.blockers.some((b: { code: string }) => b.code === "CA_EXTRA_NETWORKS"));
  assert.deepEqual(docker.mutations(), []);
});

test("a paused or restarting app is not updated", async () => {
  await setPermissions(ALL_CA);
  for (const state of [{ paused: true }, { status: "restarting" }]) {
    const docker = runningJellyfin(state);
    const { app } = await harness(docker);
    const res = await post(app, "/api/ca/app/jellyfin/update");
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "CA_UNSTABLE_STATE");
    assert.deepEqual(docker.mutations(), []);
  }
});

test("a paused app can be removed, a restarting one cannot", async () => {
  await setPermissions(ALL_CA);
  const paused = runningJellyfin({ paused: true });
  const first = await harness(paused);
  assert.equal((await post(first.app, "/api/ca/app/jellyfin/remove")).statusCode, 200);
  assert.deepEqual(paused.mutations().map((r) => r[1]), ["stop", "rm"]);

  const restarting = runningJellyfin({ status: "restarting" });
  const second = await harness(restarting);
  const res = await post(second.app, "/api/ca/app/jellyfin/remove");
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "CA_UNSTABLE_STATE");
});

test("a value with deliberate spaces survives the update unchanged", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  const { app } = await harness(docker, {
    "my-jellyfin.xml": templateXml({
      name: "jellyfin",
      image: "jellyfin/jellyfin:latest",
      configs: [
        { label: "Config", target: "/config", type: "Path", mode: "rw", value: "/mnt/user/appdata/jellyfin-custom" },
        { label: "Greeting", target: "GREETING", type: "Variable", value: "  padded value  " },
      ],
    }),
  });

  const res = await post(app, "/api/ca/app/jellyfin/update", { dryRun: true });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().data.plan.env, ["GREETING=  padded value  "]);
});

// ── Not inventing facts about docker ────────────────────────────

test("a docker daemon that cannot answer is never read as a removal", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  const realRun = docker.run;
  let removed = false;
  const { app } = await harness(docker, undefined, {
    // The removal itself succeeds; the inspect that would confirm it fails for
    // a reason that is not "no such container".
    run: async (file: string, args: string[]) => {
      if (removed && args[0] === "inspect") {
        throw new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
      }
      const result = await realRun(file, args);
      if (args[0] === "rm") removed = true;
      return result;
    },
  });

  const res = await post(app, "/api/ca/app/jellyfin/remove");
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "CA_REMOVE_UNVERIFIED");
  assert.match(res.json().error.message, /could not be asked/);
});

test("a docker daemon that cannot answer stops an update before it starts", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  const realRun = docker.run;
  const { app } = await harness(docker, undefined, {
    run: async (file: string, args: string[]) => {
      // The reserved-name lookups happen after the pull. An unknown answer
      // there must not be read as "the name is free".
      if (args[0] === "inspect" && String(args[args.length - 1]).includes("unraidclaw-")) {
        throw new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
      }
      return await realRun(file, args);
    },
  });

  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, "CA_DOCKER_UNAVAILABLE");
  assert.ok(!docker.mutations().some((r) => r[1] === "create"), "nothing was created");
  assert.equal(docker.byRef("jellyfin")?.running, true);
});

test("a failed create never removes a container by name", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  // Somebody else's container is sitting on the candidate name by the time
  // create runs, so create fails with a conflict.
  const realRun = docker.run;
  let created = false;
  const { app } = await harness(docker, undefined, {
    run: async (file: string, args: string[]) => {
      if (args[0] === "create") {
        created = true;
        docker.runs.push([file, ...args]);
        throw new Error('Conflict. The container name "/jellyfin.unraidclaw-new" is already in use');
      }
      return await realRun(file, args);
    },
  });

  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "CA_CREATE_FAILED");
  assert.ok(created);
  assert.ok(!docker.runs.some((r) => r[1] === "rm"), "no rm was attempted at all");
  assert.equal(docker.byRef("jellyfin")?.running, true);
});

test("a rollback that cannot rename the original back says so", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  docker.failures.start = "port is already allocated";
  docker.alwaysFail.rename = "rename failed";
  const { app } = await harness(docker);

  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 500);
  const { error } = res.json();
  // The first rename is what fails, so the update never gets as far as starting.
  assert.equal(error.code, "CA_UPDATE_INCOMPLETE");
  assert.match(error.message, /needs attention/);
  assert.ok(Array.isArray(error.details.problems) && error.details.problems.length > 0);
});

// ── Secrets ─────────────────────────────────────────────────────

const WITH_SECRET = templateXml({
  name: "jellyfin",
  image: "jellyfin/jellyfin:latest",
  configs: [
    { label: "Config", target: "/config", type: "Path", mode: "rw", value: "/mnt/user/appdata/jellyfin-custom" },
    { label: "API key", target: "API_KEY", type: "Variable", value: "hunter2-very-secret", mask: true },
  ],
});

test("a masked value reaches docker but never the response", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  const { app } = await harness(docker, { "my-jellyfin.xml": WITH_SECRET });

  const preview = await post(app, "/api/ca/app/jellyfin/update", { dryRun: true });
  assert.equal(preview.statusCode, 200);
  assert.ok(!preview.payload.includes("hunter2-very-secret"), "the dry run does not echo the secret");
  assert.ok(preview.payload.includes("API_KEY=***"));

  const done = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(done.statusCode, 200);
  assert.ok(!done.payload.includes("hunter2-very-secret"), "the result does not echo the secret");
  // The real value did reach the runner.
  assert.ok(docker.runs.find((r) => r[1] === "create")!.includes("API_KEY=hunter2-very-secret"));
});

test("a docker error quoting the command does not leak a masked value", async () => {
  await setPermissions(ALL_CA);
  const docker = runningJellyfin();
  docker.failures.create =
    'invalid argument: docker create --name jellyfin.unraidclaw-new -e API_KEY=hunter2-very-secret jellyfin/jellyfin:latest';
  const { app } = await harness(docker, { "my-jellyfin.xml": WITH_SECRET });

  const res = await post(app, "/api/ca/app/jellyfin/update");
  assert.equal(res.statusCode, 500);
  assert.ok(!res.payload.includes("hunter2-very-secret"), "the error does not echo the secret");
  assert.match(res.json().error.message, /API_KEY=\*\*\*/);
});

// ── OpenClaw tools ──────────────────────────────────────────────

test("the OpenClaw tools call the update and remove endpoints they document", async () => {
  const { registerCaTools } = await import("../../../openclaw-plugin/src/tools/ca.js");

  interface Registered {
    name: string;
    description: string;
    parameters: { properties: Record<string, unknown>; required?: string[] };
    execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
    optional: boolean;
  }
  const tools: Registered[] = [];
  const api = {
    registerTool: (tool: Omit<Registered, "optional">, opts?: { optional?: boolean }) =>
      tools.push({ ...tool, optional: opts?.optional === true }),
  };
  const calls: Array<[string, unknown]> = [];
  const client = { get: async () => ({}), post: async (url: string, body: unknown) => { calls.push([url, body]); return { ok: true }; } };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerCaTools(api as any, (() => client) as any);

  const update = tools.find((t) => t.name === "unraid_ca_update")!;
  const remove = tools.find((t) => t.name === "unraid_ca_remove")!;
  assert.ok(update, "unraid_ca_update is registered");
  assert.ok(remove, "unraid_ca_remove is registered");
  assert.equal(update.optional, true, "a mutating tool is optional");
  assert.equal(remove.optional, true);
  // The parameter is the installed container's name, and the tools say so.
  assert.match(update.description, /container name/i);
  assert.match(remove.description, /container name/i);
  assert.deepEqual(update.parameters.required, ["name"]);
  assert.deepEqual(remove.parameters.required, ["name"]);
  assert.ok("dryRun" in update.parameters.properties);
  assert.ok("dryRun" in remove.parameters.properties);

  await update.execute("1", { name: "my app", dryRun: true });
  await remove.execute("2", { name: "jellyfin" });
  assert.deepEqual(calls, [
    ["/api/ca/app/my%20app/update", { dryRun: true }],
    ["/api/ca/app/jellyfin/remove", {}],
  ]);
});

test("a mistyped dryRun on a mutating tool sends nothing at all", async () => {
  const { registerCaTools } = await import("../../../openclaw-plugin/src/tools/ca.js");
  const { registerPluginTools } = await import("../../../openclaw-plugin/src/tools/plugins.js");

  interface Registered {
    name: string;
    parameters: { additionalProperties?: boolean };
    execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }
  const tools: Registered[] = [];
  const api = { registerTool: (tool: Registered) => tools.push(tool) };
  const calls: Array<[string, unknown]> = [];
  const client = {
    get: async () => ({}),
    post: async (url: string, body: unknown) => {
      calls.push([url, body]);
      return { ok: true };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerCaTools(api as any, (() => client) as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPluginTools(api as any, (() => client) as any);

  // Every tool that changes something on the server. A dropped dryRun here
  // means a real install, update or removal, and on the plugin side a vendor
  // script running as root.
  const mutating: Array<[string, Record<string, unknown>]> = [
    ["unraid_ca_install", { name: "Jellyfin" }],
    ["unraid_ca_update", { name: "jellyfin" }],
    ["unraid_ca_remove", { name: "jellyfin" }],
    ["unraid_plugin_install", { url: "https://example.invalid/x.plg" }],
    ["unraid_plugin_check_updates", { plugin: "x.plg" }],
    ["unraid_plugin_update", { plugin: "x.plg" }],
    ["unraid_plugin_remove", { plugin: "x.plg" }],
  ];

  for (const [name, valid] of mutating) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} is registered`);
    assert.equal(tool!.parameters.additionalProperties, false, `${name} declares no extra parameters`);

    for (const bad of [{ dryrun: true }, { DryRun: true }, { dryRun: "false" }, { nonsense: 1 }]) {
      const result = await tool!.execute("1", { ...valid, ...bad });
      assert.match(result.content[0].text, /^Error: /, `${name} rejects ${JSON.stringify(bad)}`);
      assert.match(result.content[0].text, /Nothing was sent to the server/);
      assert.deepEqual(calls, [], `${name} sent a request for ${JSON.stringify(bad)}`);
    }

    // The correctly spelled flag still gets through, and reaches the API as
    // written so the server's own check sees it too.
    await tool!.execute("1", { ...valid, dryRun: true });
    assert.equal(calls.length, 1, `${name} forwards a valid dryRun`);
    assert.equal((calls[0][1] as Record<string, unknown>).dryRun, true);
    calls.length = 0;

    await tool!.execute("1", { ...valid, dryRun: false });
    assert.equal((calls[0][1] as Record<string, unknown>).dryRun, false, `${name} forwards dryRun: false verbatim`);
    calls.length = 0;
  }
});
