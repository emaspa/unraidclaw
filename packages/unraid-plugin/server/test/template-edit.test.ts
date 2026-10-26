// Behavioural tests for reading and editing an installed container's saved
// template.
//
// The edit routes run for real through app.inject(), with real template files
// in a temp directory. Everything outside the process is a fake host: docker
// is an in-memory container list, the command script is a stand-in that builds
// a command from the staged template the way Unraid's xmlToCommand does, and
// bash only runs commands that stand-in produced. Nothing here touches a real
// Unraid server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaRuntime } from "../src/routes/ca.js";
import type { TemplateRuntime } from "../src/routes/template.js";

const flashBase = await mkdtemp(join(tmpdir(), "unraidclaw-template-"));
process.env.FLASH_BASE = flashBase;

const { loadPermissions } = await import("../src/config.js");
const { registerCaRoutes, createCaRuntime } = await import("../src/routes/ca.js");
const { registerTemplateRoutes, createTemplateRuntime } = await import("../src/routes/template.js");
const { applyTemplateEdit, parseTemplateEditBody, templateView } = await import("../src/template-edit.js");
const { parseSavedTemplate, normalizeImage } = await import("../src/ca-saved-template.js");
const { CaFeed } = await import("../src/ca-feed.js");
const Fastify = (await import("fastify")).default;

const EDIT = { "template:read": true, "template:update": true };

async function setPermissions(perms: Record<string, boolean>): Promise<void> {
  await writeFile(join(flashBase, "permissions.json"), JSON.stringify(perms), "utf8");
  loadPermissions();
}

// ── Templates ───────────────────────────────────────────────────

const SECRET = "hunter2-api-key";

function templateXml(opts: { image?: string; network?: string; extra?: string; configs?: string } = {}): string {
  return `<?xml version="1.0"?>
<Container version="2">
  <Name>jellyfin</Name>
  <Repository>${opts.image ?? "jellyfin/jellyfin:latest"}</Repository>
  <Registry/>
  <Network>${opts.network ?? "bridge"}</Network>
  <MyIP/>
  <Shell>sh</Shell>
  <Privileged>false</Privileged>
  <Support>https://example.invalid/support</Support>
  <Overview>Tom &amp; Jerry &lt;3 media</Overview>
  <WebUI>http://[IP]:[PORT:8096]/</WebUI>
  <Icon>https://example.invalid/jellyfin.png</Icon>
  <ExtraParams/>
  <PostArgs/>
  <CPUset/>
  <DateInstalled>1700000000</DateInstalled>${opts.extra ?? ""}
  <Config Name="WebUI" Target="8096" Default="8096" Mode="tcp" Description="Web interface" Type="Port" Display="always" Required="false" Mask="false">18096</Config>
  <Config Name="Config" Target="/config" Default="/mnt/user/appdata/jellyfin" Mode="rw" Description="" Type="Path" Display="always" Required="true" Mask="false">/mnt/user/appdata/jellyfin</Config>
  <Config Name="PUID" Target="PUID" Default="99" Mode="" Description="" Type="Variable" Display="advanced" Required="false" Mask="false">99</Config>
  <Config Name="API key" Target="API_KEY" Default="" Mode="" Description="" Type="Variable" Display="always" Required="false" Mask="true">${SECRET}</Config>${opts.configs ?? ""}
</Container>
`;
}

// ── A fake host ─────────────────────────────────────────────────

interface Mount {
  Type: string;
  Source?: string;
  Name?: string;
  Destination: string;
  RW?: boolean;
}

interface Box {
  id: string;
  name: string;
  image: string;
  running: boolean;
  status?: string;
  labels: Record<string, string>;
  mounts: Mount[];
  network: string;
  privileged: boolean;
  /** The image id it was created from. */
  imageId?: string;
}

interface BuiltSpec {
  name: string;
  image: string;
  network: string;
  privileged: boolean;
  mounts: Mount[];
}

class FakeHost {
  /** Image ids by normalized tag. */
  images = new Map<string, string>();
  /** The id a tag gets on its next pull, to stand in for a newer upstream image. */
  pullTo = new Map<string, string>();
  containers: Box[] = [];
  runs: string[][] = [];
  networks = new Set(["bridge", "host", "none", "br0"]);
  /** Commands the fake command script produced, so bash can only run those. */
  built = new Map<string, BuiltSpec>();
  /** One-shot failures keyed by what fails: create, start, stop, rename, rm, php, network. */
  failures: Record<string, string> = {};
  /** The next container started exits straight away, as a broken app would. */
  crashOnStart = false;
  private seq = 0;

  hexId(): string {
    return (++this.seq).toString(16).padStart(64, "0");
  }

  byRef(ref: string): Box | undefined {
    return this.containers.find((c) => c.name === ref || c.id === ref);
  }

  /** Every call that changes something: not an inspect, a log read or a command build. */
  mutations(): string[][] {
    return this.runs.filter(
      (r) =>
        r[0] === "/bin/bash" ||
        (r[0] === "docker" && !["inspect", "logs"].includes(r[1]) && !(r[1] === "image" && r[2] === "inspect"))
    );
  }

  private fail(key: string): void {
    const message = this.failures[key];
    if (message) {
      delete this.failures[key];
      throw new Error(message);
    }
  }

  private inspect(c: Box): string {
    return JSON.stringify({
      Id: c.id,
      Name: `/${c.name}`,
      Image: c.imageId ?? `sha256:img-${normalizeImage(c.image)}`,
      State: {
        Status: c.status ?? (c.running ? "running" : "exited"),
        Running: c.running,
        Paused: false,
        Restarting: c.status === "restarting",
        Dead: false,
      },
      Config: { Image: c.image, Labels: c.labels },
      HostConfig: { NetworkMode: c.network, Privileged: c.privileged, RestartPolicy: { Name: "no" }, PidsLimit: 2048 },
      Mounts: c.mounts,
      NetworkSettings: { Networks: { [c.network]: {} } },
    });
  }

  /** A stand-in for scripts/docker-command: xmlToCommand's shape, from the staged file. */
  private async buildCommand(args: string[]): Promise<string> {
    this.fail("php");
    const [, staged, createName, extrasJson] = args;
    const xml = await readFile(staged, "utf8");
    const tpl = parseSavedTemplate(xml, staged);
    const view = templateView(xml, staged);
    const requested = view.settings.Network ?? "bridge";
    const network = this.networks.has(requested) ? requested : "none";
    const privileged = view.settings.Privileged === "true";
    const extras = JSON.parse(extrasJson) as string[];
    const q = (s: string) => `'${s}'`;
    const parts = [
      "/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/docker create",
      `--name=${q(createName)}`,
      ...extras.map((v) => `-v ${q(v)}`),
      `--net=${q(network)}`,
      privileged ? "--privileged=true" : "",
      ...tpl.resolved.env.map((e) => `-e ${q(e)}`),
      "-l net.unraid.docker.managed=dockerman",
      ...tpl.resolved.ports.map((p) => `-p ${q(p)}`),
      ...tpl.resolved.volumes.map((v) => `-v ${q(v)}`),
      view.settings.ExtraParams ?? "",
      q(tpl.resolved.image),
    ].filter(Boolean);
    const command = parts.join(" ");
    const mounts: Mount[] = [...tpl.resolved.volumes, ...extras].map((v) => {
      const [source, destination] = v.split(":");
      return source.startsWith("/")
        ? { Type: "bind", Source: source, Destination: destination, RW: true }
        : { Type: "volume", Name: source, Destination: destination, RW: true };
    });
    this.built.set(command, { name: createName, image: tpl.resolved.image, network, privileged, mounts });
    return JSON.stringify({
      command,
      name: tpl.resolved.name,
      repository: tpl.resolved.image,
      network,
      requestedNetwork: requested,
      extraNetworks: (view.settings.ExtraNetworks ?? "").split(/[\s,]+/).filter(Boolean),
    });
  }

  run = async (file: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    this.runs.push([file, ...args]);
    if (file === "/usr/bin/php") return { stdout: `${await this.buildCommand(args)}\n`, stderr: "" };

    if (file === "/bin/bash") {
      const spec = this.built.get(args[1]);
      if (args[0] !== "-c" || !spec) throw new Error("bash was asked to run a command the command script did not build");
      this.fail("create");
      if (this.byRef(spec.name)) throw new Error(`Conflict. The container name "/${spec.name}" is already in use`);
      const box: Box = {
        id: this.hexId(),
        name: spec.name,
        image: spec.image,
        running: false,
        labels: { "net.unraid.docker.managed": "dockerman" },
        mounts: spec.mounts,
        network: spec.network,
        privileged: spec.privileged,
        imageId: this.images.get(normalizeImage(spec.image)),
      };
      this.containers.push(box);
      return { stdout: `${box.id}\n`, stderr: "" };
    }

    if (file !== "docker") throw new Error(`the fake was asked to run ${file}`);
    const cmd = args[0];
    if (cmd === "inspect") {
      const c = this.byRef(args[args.length - 1]);
      if (!c) throw new Error(`Error: No such container: ${args[args.length - 1]}`);
      return { stdout: `${this.inspect(c)}\n`, stderr: "" };
    }
    if (cmd === "image" && args[1] === "inspect") {
      const ref = normalizeImage(args[args.length - 1]);
      if (!this.images.has(ref)) throw new Error(`Error: No such image: ${ref}`);
      return { stdout: `${JSON.stringify({ Id: this.images.get(ref), Config: {} })}\n`, stderr: "" };
    }
    if (cmd === "pull") {
      const ref = normalizeImage(args[1]);
      this.images.set(ref, this.pullTo.get(ref) ?? this.images.get(ref) ?? `sha256:img-${ref}`);
      return { stdout: "", stderr: "" };
    }
    if (cmd === "logs") {
      return { stdout: `starting\nusing key ${SECRET}\n`, stderr: "fatal: bad config\n" };
    }
    if (cmd === "network" && args[1] === "connect") {
      this.fail("network");
      return { stdout: "", stderr: "" };
    }
    if (["stop", "start", "rename", "rm"].includes(cmd)) {
      const ref = cmd === "rm" ? args[args.length - 1] : args[1];
      const c = this.byRef(ref);
      if (!c) throw new Error(`Error: No such container: ${ref}`);
      this.fail(cmd);
      if (cmd === "stop") {
        c.running = false;
        c.status = undefined;
      }
      if (cmd === "start") {
        c.running = true;
        c.status = undefined;
        if (this.crashOnStart) {
          this.crashOnStart = false;
          c.running = false;
          c.status = "exited";
        }
      }
      if (cmd === "rename") c.name = args[2];
      if (cmd === "rm") this.containers = this.containers.filter((x) => x !== c);
      return { stdout: "", stderr: "" };
    }
    throw new Error(`the fake does not implement "docker ${args.join(" ")}"`);
  };
}

/** A host with a running jellyfin, installed from the default template. */
function runningJellyfin(extra: Partial<Box> = {}): FakeHost {
  const host = new FakeHost();
  host.images.set(normalizeImage("jellyfin/jellyfin:latest"), `sha256:img-${normalizeImage("jellyfin/jellyfin:latest")}`);
  host.containers.push({
    id: "a".repeat(64),
    name: "jellyfin",
    image: "jellyfin/jellyfin:latest",
    running: true,
    labels: { "net.unraid.docker.managed": "dockerman" },
    mounts: [
      { Type: "bind", Source: "/mnt/user/appdata/jellyfin", Destination: "/config", RW: true },
      { Type: "volume", Name: "jellyfin-cache", Destination: "/cache", RW: true },
    ],
    network: "bridge",
    privileged: false,
    ...extra,
  });
  return host;
}

interface Harness {
  app: ReturnType<typeof Fastify>;
  host: FakeHost;
  templatesDir: string;
  backupDir: string;
  lifecycle: ReturnType<typeof registerCaRoutes>;
  created: string[];
}

async function harness(host: FakeHost, xml = templateXml(), overrides: Partial<Omit<TemplateRuntime, "ca">> = {}, ca: Partial<CaRuntime> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "unraidclaw-edit-host-"));
  const templatesDir = join(root, "templates-user");
  const backupDir = join(root, "template-backups");
  await mkdir(templatesDir, { recursive: true });
  await writeFile(join(templatesDir, "my-jellyfin.xml"), xml, "utf8");
  const created: string[] = [];

  const caRuntime = createCaRuntime({
    feed: new CaFeed({
      fetchImpl: (async () => {
        throw new Error("template edits must not fetch the CA catalog");
      }) as unknown as typeof fetch,
    }),
    templatesDir,
    run: host.run,
    readHostVars: async () => ({ timeZone: "Europe/Rome", hostName: "Tower" }),
    ensureHostDir: async (path) => {
      created.push(path);
    },
    ...ca,
  });
  const app = Fastify();
  const lifecycle = registerCaRoutes(app, caRuntime);
  registerTemplateRoutes(
    app,
    lifecycle,
    createTemplateRuntime(caRuntime, {
      backupDir,
      wait: async () => undefined,
      settleMs: 0,
      pathExists: async (path) => path.startsWith("/mnt/user/appdata/jellyfin"),
      now: () => new Date("2026-09-25T12:00:00Z"),
      ...overrides,
    })
  );
  await app.ready();
  return { app, host, templatesDir, backupDir, lifecycle, created };
}

const post = (app: Harness["app"], url: string, payload: unknown = {}) =>
  app.inject({ method: "POST", url, payload: payload as object, headers: { "content-type": "application/json" } });

const edit = (h: Harness, payload: unknown) => post(h.app, "/api/template/jellyfin/edit", payload);
const savedTemplate = (h: Harness) => readFile(join(h.templatesDir, "my-jellyfin.xml"), "utf8");

// ── Request bodies ──────────────────────────────────────────────

test("an edit body rejects unknown fields, misspellings and a rename", () => {
  assert.throws(() => parseTemplateEditBody({ dryrun: true, settings: { Network: "br0" } }), /Did you mean "dryRun"/);
  assert.throws(() => parseTemplateEditBody({ settings: { network: "br0" } }), /Did you mean "Network"/);
  assert.throws(() => parseTemplateEditBody({ settings: { Name: "plex" } }), /Renaming is not supported/);
  assert.throws(() => parseTemplateEditBody({ settings: { Privileged: "yes" } }), /"true" or "false"/);
  assert.throws(() => parseTemplateEditBody({ settings: { ExtraParams: "--a\n--b" } }), /control character/);
  assert.throws(() => parseTemplateEditBody({}), /Nothing to change/);
  assert.throws(() => parseTemplateEditBody({ dryRun: "true", settings: { Network: "br0" } }), /true or false/);
});

test("Extra Parameters and Post Arguments an edit sets take only what the shell cannot act on", () => {
  // Unraid's xmlToCommand quotes every other value and passes these two to the
  // shell as they are.
  for (const key of ["ExtraParams", "PostArgs"]) {
    for (const value of ["--x; id", "--x $(id)", "--label 'a b'", '--x "y"', "--x`id`", "--a  --b", "--x|id", "--x>/tmp/f"]) {
      assert.throws(() => parseTemplateEditBody({ settings: { [key]: value } }), /unescaped/, `${key} ${value}`);
    }
    assert.doesNotThrow(() => parseTemplateEditBody({ settings: { [key]: "--device=/dev/dri --memory=8g" } }));
    assert.doesNotThrow(() => parseTemplateEditBody({ settings: { [key]: "" } }), "an empty value clears it");
  }
  assert.throws(() => parseTemplateEditBody({ settings: { ExtraParams: "-a ".repeat(1000) } }), /unescaped/);
});

test("an edit body checks each config entry for its type", () => {
  const bad = (entry: Record<string, unknown>) => () => parseTemplateEditBody({ config: [entry] });
  assert.throws(bad({ type: "Port", target: "70000", value: "8080" }), /container port/);
  assert.throws(bad({ type: "Port", target: "80", value: "http" }), /host port/);
  assert.throws(bad({ type: "Port", target: "80", value: "8080", mode: "sctp" }), /tcp or udp/);
  assert.throws(bad({ type: "Path", target: "/data", value: "/mnt/a:b" }), /without ":"/);
  assert.throws(bad({ type: "Path", target: "data", value: "/mnt/a" }), /absolute container path/);
  assert.throws(bad({ type: "Variable", target: "A B", value: "1" }), /without spaces/);
  assert.throws(bad({ type: "Device", value: "/mnt/dri" }), /under \/dev\//);
  assert.throws(bad({ type: "Device", value: "/dev/" }), /every device/);
  assert.throws(bad({ type: "Device", value: "/dev/../etc/shadow" }), /every device|under \/dev\//);
  assert.throws(bad({ type: "Device", value: "/dev/." }), /every device/);
  assert.throws(bad({ type: "Device", value: "/dev//" }), /every device/);
  assert.doesNotThrow(bad({ type: "Device", value: "/dev/dri" }));
  assert.doesNotThrow(bad({ type: "Device", value: "/dev/ttyUSB0:/dev/ttyACM0" }));
  assert.throws(bad({ type: "Socket", target: "x", value: "y" }), /must be one of/);
  assert.throws(bad({ type: "Variable", target: "A", value: "1", colour: "red" }), /Unknown field "colour"/);
  assert.doesNotThrow(bad({ type: "Path", target: "/media", value: "/mnt/user/media", mode: "ro,slave" }));
});

// ── Applying an edit to the XML ─────────────────────────────────

test("an edit changes only what it names and keeps everything else in the template", () => {
  const xml = templateXml();
  const out = applyTemplateEdit(xml, "t.xml", parseTemplateEditBody({ config: [{ type: "Variable", target: "PUID", value: "1000" }] }));
  assert.deepEqual(out.changes, [{ field: "Variable PUID", before: "99", after: "1000" }]);

  const before = templateView(xml, "t.xml");
  const after = templateView(out.xml, "t.xml");
  assert.deepEqual(after.settings, before.settings, "no setting moved");
  assert.equal(after.config.length, before.config.length);
  assert.equal(after.config.find((c) => c.target === "PUID")?.value, "1000");
  assert.equal(after.config.find((c) => c.target === "PUID")?.display, "advanced", "untouched attributes are kept");
  // Metadata the edit never names survives byte for byte, entities included.
  assert.match(out.xml, /<Overview>Tom &amp; Jerry &lt;3 media<\/Overview>/);
  assert.match(out.xml, /<Support>https:\/\/example.invalid\/support<\/Support>/);
  assert.match(out.xml, /^<\?xml version="1.0"\?>\n<Container version="2">/);
});

test("CDATA, comments, entities and Tailscale settings read back the same after an edit", () => {
  const xml = templateXml({
    extra: `
  <!-- written by hand -->
  <Description><![CDATA[Streams <b>media</b> & more]]></Description>
  <TailscaleEnabled>true</TailscaleEnabled>
  <TailscaleHostname>jelly</TailscaleHostname>
  <TailscaleServe>serve</TailscaleServe>`,
    configs: `\n  <Config Name="Say &quot;hi&quot;" Target="GREETING" Default="a &amp; b" Mode="" Description="&lt;tag&gt;" Type="Variable" Display="always" Required="true" Mask="false"/>`,
  });
  const out = applyTemplateEdit(xml, "t.xml", parseTemplateEditBody({ config: [{ type: "Variable", target: "PUID", value: "1000" }] }));
  const before = parseSavedTemplate(xml, "t.xml");
  const after = parseSavedTemplate(out.xml, "t.xml");
  assert.deepEqual(after.resolved.env.filter((e) => !e.startsWith("PUID=")), before.resolved.env.filter((e) => !e.startsWith("PUID=")));
  assert.deepEqual(after.resolved.volumes, before.resolved.volumes);
  assert.deepEqual(after.resolved.ports, before.resolved.ports);
  const view = templateView(out.xml, "t.xml");
  assert.equal(view.settings.TailscaleEnabled, "true");
  assert.equal(view.settings.TailscaleHostname, "jelly");
  const greeting = view.config.find((c) => c.target === "GREETING");
  assert.deepEqual([greeting?.name, greeting?.default, greeting?.description, greeting?.required], ['Say "hi"', "a & b", "<tag>", true]);
  assert.match(out.xml, /<Description>Streams &lt;b&gt;media&lt;\/b&gt; &amp; more<\/Description>/);
});

test("repeated edits do not pile up blank lines in the template", () => {
  let xml = templateXml();
  for (const value of ["1", "2", "3"]) {
    xml = applyTemplateEdit(xml, "t.xml", parseTemplateEditBody({ config: [{ type: "Variable", target: "PUID", value }] })).xml;
  }
  assert.doesNotMatch(xml, /\n\s*\n/);
});

test("settings the template lacks are added before its config entries", () => {
  const out = applyTemplateEdit(
    templateXml(),
    "t.xml",
    parseTemplateEditBody({ settings: { Memory: "4G", Privileged: "true", ExtraParams: "--device=/dev/dri --gpus all" } })
  );
  assert.ok(out.xml.indexOf("<Memory>4G</Memory>") < out.xml.indexOf("<Config "));
  assert.match(out.xml, /<Privileged>true<\/Privileged>/);
  assert.match(out.xml, /<ExtraParams>--device=\/dev\/dri --gpus all<\/ExtraParams>/);
  assert.deepEqual(
    out.changes.map((c) => c.field).sort(),
    ["ExtraParams", "Memory", "Privileged"]
  );
});

test("a new config entry gets the Docker tab's defaults", () => {
  const out = applyTemplateEdit(
    templateXml(),
    "t.xml",
    parseTemplateEditBody({
      config: [
        { type: "Port", target: "1900", value: "1900", mode: "udp", name: "DLNA" },
        { type: "Path", target: "/media", value: "/mnt/user/media" },
        { type: "Device", value: "/dev/dri" },
      ],
    })
  );
  const view = templateView(out.xml, "t.xml");
  const port = view.config.find((c) => c.target === "1900");
  assert.deepEqual([port?.name, port?.mode, port?.value, port?.display], ["DLNA", "udp", "1900", "always"]);
  assert.equal(view.config.find((c) => c.target === "/media")?.mode, "rw");
  assert.equal(view.config.find((c) => c.type === "Device")?.value, "/dev/dri");
  assert.deepEqual(out.changes.map((c) => c.field), ["Port 1900/udp", "Path /media", "Device /dev/dri"]);
});

test("ports are matched with their protocol, so tcp and udp are separate entries", () => {
  const out = applyTemplateEdit(
    templateXml(),
    "t.xml",
    parseTemplateEditBody({ config: [{ type: "Port", target: "8096", value: "28096", mode: "udp" }] })
  );
  const ports = templateView(out.xml, "t.xml").config.filter((c) => c.target === "8096");
  assert.deepEqual(ports.map((p) => `${p.value}/${p.mode}`).sort(), ["18096/tcp", "28096/udp"]);
});

test("clearing a value clears its default too, so Unraid does not bring the default back", () => {
  const out = applyTemplateEdit(templateXml(), "t.xml", parseTemplateEditBody({ config: [{ type: "Variable", target: "PUID", value: "" }] }));
  const puid = templateView(out.xml, "t.xml").config.find((c) => c.target === "PUID");
  assert.deepEqual([puid?.value, puid?.default], ["", ""]);
});

test("entries can be removed, and removing one that is not there is refused", () => {
  const out = applyTemplateEdit(templateXml(), "t.xml", parseTemplateEditBody({ removeConfig: [{ type: "Port", target: "8096" }] }));
  assert.equal(templateView(out.xml, "t.xml").config.some((c) => c.type === "Port"), false);
  assert.deepEqual(out.changes, [{ field: "Port 8096/tcp", before: "18096", after: "" }]);
  assert.throws(
    () => applyTemplateEdit(templateXml(), "t.xml", parseTemplateEditBody({ removeConfig: [{ type: "Port", target: "8096", mode: "udp" }] })),
    (err: Error & { code?: string }) => err.code === "TEMPLATE_CONFIG_NOT_FOUND"
  );
});

test("a device is replaced by naming the one it replaces", () => {
  const xml = templateXml({ configs: `\n  <Config Name="GPU" Target="" Default="" Mode="" Description="" Type="Device" Display="always" Required="false" Mask="false">/dev/dri</Config>` });
  const out = applyTemplateEdit(xml, "t.xml", parseTemplateEditBody({ config: [{ type: "Device", value: "/dev/dri/renderD128", replaces: "/dev/dri" }] }));
  const devices = templateView(out.xml, "t.xml").config.filter((c) => c.type === "Device");
  assert.deepEqual(devices.map((d) => [d.name, d.value]), [["GPU", "/dev/dri/renderD128"]]);
});

test("two entries matching one edit are refused rather than guessed", () => {
  const dup = `\n  <Config Name="PUID again" Target="PUID" Default="" Mode="" Description="" Type="Variable" Display="always" Required="false" Mask="false">100</Config>`;
  assert.throws(
    () => applyTemplateEdit(templateXml({ configs: dup }), "t.xml", parseTemplateEditBody({ config: [{ type: "Variable", target: "PUID", value: "1" }] })),
    (err: Error & { code?: string }) => err.code === "TEMPLATE_CONFIG_AMBIGUOUS"
  );
});

test("masked values never appear in a change or a view", () => {
  const out = applyTemplateEdit(templateXml(), "t.xml", parseTemplateEditBody({ config: [{ type: "Variable", target: "API_KEY", value: "new-secret" }] }));
  assert.deepEqual(out.changes, [{ field: "Variable API_KEY", before: "***", after: "***" }]);
  const view = templateView(out.xml, "t.xml");
  assert.equal(view.config.find((c) => c.target === "API_KEY")?.value, "***");
  assert.doesNotMatch(JSON.stringify(view), /new-secret|hunter2/);
});

test("a secret-named variable with Mask false is hidden in changes and views", () => {
  const fake = "fake-tunnel-token-not-real-0000";
  const configs = `\n  <Config Name="Tunnel token" Target="TUNNEL_TOKEN" Default="" Mode="" Description="" Type="Variable" Display="always" Required="false" Mask="false">${fake}</Config>`;
  const out = applyTemplateEdit(templateXml({ configs }), "t.xml", parseTemplateEditBody({ config: [{ type: "Variable", target: "TUNNEL_TOKEN", value: "fake-new-token-0001" }] }));
  assert.deepEqual(out.changes, [{ field: "Variable TUNNEL_TOKEN", before: "***", after: "***" }]);
  const added = applyTemplateEdit(templateXml(), "t.xml", parseTemplateEditBody({ config: [{ type: "Variable", target: "DB_PASSWORD", value: "fake-db-pass-0002" }] }));
  assert.deepEqual(added.changes, [{ field: "Variable DB_PASSWORD", before: "", after: "***" }]);
  const view = templateView(templateXml({ configs }), "t.xml");
  const entry = view.config.find((c) => c.target === "TUNNEL_TOKEN");
  assert.equal(entry?.value, "***");
  assert.equal(entry?.mask, false, "the template's own Mask attribute is reported as it is");
  assert.equal(view.config.find((c) => c.target === "PUID")?.value, "99");
  assert.doesNotMatch(JSON.stringify(view), new RegExp(fake));
});

test("redaction hides secret-named assignments in text, quoted or not", async () => {
  const { redactSecrets } = await import("../src/ca-template.js");
  assert.equal(redactSecrets([], "-e TUNNEL_TOKEN=abc -e PUID=99"), "-e TUNNEL_TOKEN=*** -e PUID=99");
  assert.equal(redactSecrets([], "-e 'TUNNEL_TOKEN'='abc def' -e 'PUID'='99'"), "-e 'TUNNEL_TOKEN'=*** -e 'PUID'='99'");
  assert.equal(redactSecrets([], "api_key=x my_secret=y Password=z credential=w AuthHeader=v"), "api_key=*** my_secret=*** Password=*** credential=*** AuthHeader=***");
  assert.equal(redactSecrets(["fake-value-123"], "saw fake-value-123 here"), "saw *** here");
});

// ── Permissions ─────────────────────────────────────────────────

test("reading and editing are off in a default permission file", async () => {
  await setPermissions({});
  const h = await harness(runningJellyfin());
  assert.equal((await h.app.inject({ method: "GET", url: "/api/template/jellyfin" })).statusCode, 403);
  assert.equal((await edit(h, { settings: { Privileged: "true" } })).statusCode, 403);
  assert.deepEqual(h.host.runs, [], "nothing was run");
});

test("an edit needs template:update even with every CA and Docker permission", async () => {
  await setPermissions({
    "template:read": true, "ca:read": true, "ca:create": true, "ca:update": true, "ca:delete": true,
    "docker:read": true, "docker:create": true, "docker:update": true, "docker:delete": true,
  });
  const h = await harness(runningJellyfin());
  assert.equal((await edit(h, { settings: { Privileged: "true" } })).statusCode, 403);
  assert.deepEqual(h.host.runs, []);
});

// ── Reading ─────────────────────────────────────────────────────

test("reading a template shows its settings and config with secrets hidden", async () => {
  await setPermissions({ "template:read": true });
  const h = await harness(runningJellyfin());
  const res = await h.app.inject({ method: "GET", url: "/api/template/jellyfin" });
  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.name, "jellyfin");
  assert.equal(data.settings.Network, "bridge");
  assert.equal(data.config.find((c: { target: string }) => c.target === "API_KEY").value, "***");
  assert.doesNotMatch(res.body, new RegExp(SECRET));
  assert.equal((await h.app.inject({ method: "GET", url: "/api/template/plex" })).statusCode, 404);
});

// ── Dry runs ────────────────────────────────────────────────────

test("a dry run reports the changes and Unraid's command and changes nothing", async () => {
  await setPermissions(EDIT);
  const h = await harness(runningJellyfin());
  const res = await edit(h, {
    dryRun: true,
    settings: { Privileged: "true", ExtraParams: "--device=/dev/dri" },
    config: [{ type: "Path", target: "/media", value: "/mnt/user/media", mode: "ro" }],
  });
  assert.equal(res.statusCode, 200, res.body);
  const { data } = res.json();
  assert.equal(data.dryRun, true);
  assert.equal(data.rebuilt, false);
  assert.deepEqual(data.plan.changes.map((c: { field: string }) => c.field).sort(), ["ExtraParams", "Path /media", "Privileged"]);
  assert.match(data.plan.dockerCommand, /--privileged=true/);
  assert.match(data.plan.dockerCommand, /--device=\/dev\/dri/);
  assert.match(data.plan.dockerCommand, /-v 'jellyfin-cache:\/cache:rw'/, "the docker volume is carried over");
  assert.doesNotMatch(res.body, new RegExp(SECRET));
  assert.deepEqual(data.plan.hostPathsToCreate, ["/mnt/user/media"]);
  assert.deepEqual(h.host.mutations(), [], "nothing was created, stopped or renamed");
  assert.equal(await savedTemplate(h), templateXml(), "the template is unchanged");
  assert.deepEqual(h.created, [], "no host path was created");
});

test("an edit that changes nothing rebuilds nothing", async () => {
  await setPermissions(EDIT);
  const h = await harness(runningJellyfin());
  const res = await edit(h, { config: [{ type: "Variable", target: "PUID", value: "99" }] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.rebuilt, false);
  assert.deepEqual(h.host.mutations(), []);
});

// ── Refusals ────────────────────────────────────────────────────

test("a network that does not exist is refused instead of becoming none", async () => {
  await setPermissions(EDIT);
  const h = await harness(runningJellyfin());
  const res = await edit(h, { settings: { Network: "br9" } });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "TEMPLATE_UNKNOWN_NETWORK");
  assert.deepEqual(h.host.mutations(), []);
  assert.equal(await savedTemplate(h), templateXml());
});

test("a leftover container from an unfinished swap stops the edit", async () => {
  await setPermissions(EDIT);
  const host = runningJellyfin();
  host.containers.push({ ...host.containers[0], id: "b".repeat(64), name: "jellyfin.unraidclaw-new", running: false });
  const h = await harness(host);
  const res = await edit(h, { settings: { Privileged: "true" } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "TEMPLATE_LEFTOVER_CONTAINER");
  assert.deepEqual(h.host.mutations(), []);
});

test("an edit waits its turn behind an update of the same app", async () => {
  await setPermissions(EDIT);
  const h = await harness(runningJellyfin());
  h.lifecycle.claim("jellyfin", "update");
  const res = await edit(h, { settings: { Privileged: "true" } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "CA_ACTION_IN_FLIGHT");
  h.lifecycle.release("jellyfin");
});

test("a container not made by Unraid's docker manager is refused", async () => {
  await setPermissions(EDIT);
  const h = await harness(runningJellyfin({ labels: {} }));
  const res = await edit(h, { settings: { Privileged: "true" } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "CA_NOT_MANAGED");
});

// ── The rebuild ─────────────────────────────────────────────────

test("an edit rebuilds the container from Unraid's command, then saves the template", async () => {
  await setPermissions(EDIT);
  const h = await harness(runningJellyfin());
  const res = await edit(h, {
    settings: { Privileged: "true", Network: "br0", ExtraNetworks: "proxynet" },
    config: [
      { type: "Variable", target: "PUID", value: "1000" },
      { type: "Path", target: "/media", value: "/mnt/user/media", mode: "ro" },
    ],
  });
  assert.equal(res.statusCode, 200, res.body);
  const { data } = res.json();
  assert.equal(data.rebuilt, true);
  assert.equal(data.running, true);
  assert.ok(data.backupPath.endsWith("my-jellyfin.2026-09-25T12-00-00-000Z.xml"));

  // The order that keeps the app safe: build first, then stop, move, start.
  const steps = h.host.mutations().map((r) => (r[0] === "/bin/bash" ? "create" : r.slice(1, 3).join(" ")));
  assert.deepEqual(steps, [
    "create",
    `network connect`,
    `stop ${"a".repeat(64)}`,
    `rename ${"a".repeat(64)}`,
    `rename ${h.host.containers.find((c) => c.name === "jellyfin")!.id}`,
    `start ${h.host.containers.find((c) => c.name === "jellyfin")!.id}`,
    `rm ${"a".repeat(64)}`,
  ]);

  const now = h.host.containers;
  assert.equal(now.length, 1, "only the rebuilt container is left");
  assert.deepEqual([now[0].name, now[0].running, now[0].privileged, now[0].network], ["jellyfin", true, true, "br0"]);
  assert.ok(now[0].mounts.some((m) => m.Name === "jellyfin-cache" && m.Destination === "/cache"), "the docker volume came along");

  const saved = templateView(await savedTemplate(h), "t.xml");
  assert.equal(saved.settings.Privileged, "true");
  assert.equal(saved.config.find((c) => c.target === "PUID")?.value, "1000");
  assert.equal(await readFile(data.backupPath, "utf8"), templateXml(), "the backup is the template as it was");
  assert.deepEqual(h.created, ["/mnt/user/media"], "the new host path was created");
  assert.doesNotMatch(res.body, new RegExp(SECRET));
});

test("a volume is carried over even when a template path merely starts the same way", async () => {
  await setPermissions(EDIT);
  const h = await harness(runningJellyfin());
  const res = await edit(h, { dryRun: true, config: [{ type: "Path", target: "/cache2", value: "/mnt/user/appdata/jellyfin/cache2" }] });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.json().data.plan.dockerCommand, /-v 'jellyfin-cache:\/cache:rw'/);
});

test("a volume the command already mounts through Extra Parameters is not mounted twice", async () => {
  await setPermissions(EDIT);
  const h = await harness(runningJellyfin());
  const res = await edit(h, { dryRun: true, settings: { ExtraParams: "-v jellyfin-cache:/cache" } });
  assert.equal(res.statusCode, 200, res.body);
  const command: string = res.json().data.plan.dockerCommand;
  assert.equal(command.match(/:\/cache\b/g)?.length, 1);
});

test("a stopped container is rebuilt and left stopped", async () => {
  await setPermissions(EDIT);
  const h = await harness(runningJellyfin({ running: false }));
  const res = await edit(h, { settings: { Privileged: "true" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().data.running, false);
  assert.equal(h.host.mutations().some((r) => r[1] === "start" || r[1] === "stop"), false);
});

test("a new image is pulled first, and an unchanged one is not", async () => {
  await setPermissions(EDIT);
  const h = await harness(runningJellyfin());
  await edit(h, { settings: { Privileged: "true" } });
  assert.equal(h.host.runs.some((r) => r[1] === "pull"), false, "changing settings is not an update");

  const h2 = await harness(runningJellyfin());
  const res = await edit(h2, { settings: { Repository: "jellyfin/jellyfin:10.10.0" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(h2.host.runs.some((r) => r[1] === "pull" && r[2] === "jellyfin/jellyfin:10.10.0"));
  assert.equal(h2.host.containers[0].image, "jellyfin/jellyfin:10.10.0");
});

test("a container that will not start is rolled back and the template is left alone", async () => {
  await setPermissions(EDIT);
  const host = runningJellyfin();
  host.failures.start = "port is already allocated";
  const h = await harness(host);
  const res = await edit(h, { config: [{ type: "Port", target: "8096", value: "80" }] });
  assert.equal(res.statusCode, 500);
  const { error } = res.json();
  assert.equal(error.code, "TEMPLATE_START_FAILED");
  assert.match(error.message, /port is already allocated/);
  assert.match(error.message, /put back as it was and is running again/);
  assert.match(error.details.logs, /fatal: bad config/);
  assert.doesNotMatch(res.body, new RegExp(SECRET), "log lines are redacted too");

  assert.deepEqual(
    host.containers.map((c) => [c.id, c.name, c.running]),
    [["a".repeat(64), "jellyfin", true]],
    "the original is back under its name, running"
  );
  assert.equal(await savedTemplate(h), templateXml());
});

test("a container that exits right after starting is rolled back with its logs", async () => {
  await setPermissions(EDIT);
  const host = runningJellyfin();
  const h = await harness(host);
  host.crashOnStart = true;
  const res = await edit(h, { config: [{ type: "Variable", target: "PUID", value: "0" }] });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "TEMPLATE_START_FAILED");
  assert.match(res.json().error.message, /stopped right after starting/);
  assert.deepEqual(host.containers.map((c) => [c.name, c.running]), [["jellyfin", true]]);
  assert.equal(await savedTemplate(h), templateXml());
});

test("a template that cannot be saved puts the original container back", async () => {
  await setPermissions(EDIT);
  const host = runningJellyfin();
  const h = await harness(host, templateXml(), {
    writeTemplate: async () => {
      throw new Error("read-only file system");
    },
  });
  const res = await edit(h, { settings: { Privileged: "true" } });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "TEMPLATE_WRITE_FAILED");
  assert.deepEqual(host.containers.map((c) => [c.id, c.name, c.running]), [["a".repeat(64), "jellyfin", true]]);
  assert.equal(await savedTemplate(h), templateXml());
});

test("a failed create leaves the running app and its template untouched", async () => {
  await setPermissions(EDIT);
  const host = runningJellyfin();
  host.failures.create = "invalid reference format";
  const h = await harness(host);
  const res = await edit(h, { settings: { ExtraParams: "--bogus" } });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "TEMPLATE_CREATE_FAILED");
  assert.equal(host.runs.some((r) => r[1] === "stop"), false, "the app was never stopped");
  assert.equal(await savedTemplate(h), templateXml());
});

test("a crash-looping container can be edited, and comes back running", async () => {
  await setPermissions(EDIT);
  const h = await harness(runningJellyfin({ status: "restarting" }));
  const res = await edit(h, { config: [{ type: "Variable", target: "PUID", value: "1000" }] });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().data.wasRunning, true);
  assert.equal(res.json().data.running, true);
});

test("the edit's staged copy of the template is always cleaned up", async () => {
  await setPermissions(EDIT);
  const staged: string[] = [];
  const discarded: string[] = [];
  const h = await harness(runningJellyfin(), templateXml(), {
    stageTemplate: async (xml) => {
      const dir = await mkdtemp(join(tmpdir(), "unraidclaw-stage-test-"));
      const path = join(dir, "template.xml");
      await writeFile(path, xml, "utf8");
      staged.push(path);
      return path;
    },
    discardStaged: async (path) => {
      discarded.push(path);
    },
  });
  await edit(h, { dryRun: true, settings: { Privileged: "true" } });
  h.host.failures.create = "boom";
  await edit(h, { settings: { Privileged: "true" } });
  assert.equal(staged.length, 2);
  assert.deepEqual(discarded, staged);
  assert.deepEqual(await readdir(h.backupDir).catch(() => []), ["my-jellyfin.2026-09-25T12-00-00-000Z.xml"]);
});

// ── Updating with pull ──────────────────────────────────────────

test("pull alone is a valid edit, and must be true or false", () => {
  assert.doesNotThrow(() => parseTemplateEditBody({ pull: true }));
  assert.throws(() => parseTemplateEditBody({ pull: "yes" }), /true or false/);
  assert.throws(() => parseTemplateEditBody({ pull: false }), /Nothing to change/);
});

test("an update with no newer image rebuilds nothing", async () => {
  await setPermissions(EDIT);
  const h = await harness(runningJellyfin());
  const res = await edit(h, { pull: true });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.deepEqual([d.pulled, d.rebuilt], [true, false]);
  assert.equal(d.previousImageId, d.imageId);
  assert.ok(h.host.runs.some((r) => r[1] === "pull"));
  assert.equal(h.host.mutations().some((r) => r[0] === "/bin/bash" || r[1] === "stop"), false, "no container was touched");
});

test("an update with a newer image rebuilds on it, however privileged the container is", async () => {
  await setPermissions(EDIT);
  const xml = templateXml({ extra: "\n  <Privileged>true</Privileged>" }).replace("<Privileged>false</Privileged>\n", "").replace("<ExtraParams/>", "<ExtraParams>--device=/dev/dri --cap-add=NET_ADMIN</ExtraParams>");
  const host = runningJellyfin({ privileged: true });
  host.pullTo.set(normalizeImage("jellyfin/jellyfin:latest"), "sha256:newer");
  const h = await harness(host, xml);
  const res = await edit(h, { pull: true });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.deepEqual([d.pulled, d.rebuilt, d.imageId], [true, true, "sha256:newer"]);
  assert.notEqual(d.previousImageId, "sha256:newer");
  const now = host.containers;
  assert.equal(now.length, 1);
  assert.deepEqual([now[0].imageId, now[0].privileged, now[0].running], ["sha256:newer", true, true]);
  assert.match(d.plan.dockerCommand, /--device=\/dev\/dri --cap-add=NET_ADMIN/);
  assert.equal(await savedTemplate(h), xml, "an update leaves the template as it was");
});

test("an update dry run pulls nothing and says what would happen", async () => {
  await setPermissions(EDIT);
  const host = runningJellyfin();
  host.pullTo.set(normalizeImage("jellyfin/jellyfin:latest"), "sha256:newer");
  const h = await harness(host);
  const res = await edit(h, { pull: true, dryRun: true });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.json().data.warnings.join(" "), /will be pulled first/);
  assert.equal(host.runs.some((r) => r[1] === "pull"), false);
  assert.deepEqual(host.mutations(), []);
});

test("an update that will not start on the new image goes back to the old one", async () => {
  await setPermissions(EDIT);
  const host = runningJellyfin();
  host.pullTo.set(normalizeImage("jellyfin/jellyfin:latest"), "sha256:newer");
  host.crashOnStart = true;
  const h = await harness(host);
  const res = await edit(h, { pull: true });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "TEMPLATE_START_FAILED");
  assert.deepEqual(host.containers.map((c) => [c.id, c.running]), [["a".repeat(64), true]], "the original is back, running");
});
