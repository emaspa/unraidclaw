// Reading back the docker-manager template of an app that is already
// installed, and rebuilding its container from it.
//
// This is the update/remove side of the Community Applications feature, and it
// deliberately never looks at the CA catalog: the saved template under
// /boot/config/plugins/dockerMan/templates-user is what the user configured,
// possibly years ago and possibly edited by hand in the WebGUI, and refreshing
// an app against today's catalog defaults would silently move its ports, paths
// and variables. The catalog decides nothing here.
//
// Nor does it run Unraid's own rebuild_container or update_container scripts.
// Both delete the previous image once a new one is pulled, both destroy the
// existing container before they know the replacement can be created, and
// neither propagates a docker failure as its exit status. This module builds a
// bounded argv instead and the route verifies the result with docker inspect.

import type { CaBlocker, CaConfigEntry, CaConfigType } from "@unraidclaw/shared";
import { CA_NAME_RE, CaInstallError, type ResolvedTemplate } from "./ca-template.js";
import { XmlParseError, asArray, attrOf, parseXmlDocument, textOf } from "./xml.js";

/** Networks whose behavior we can reproduce exactly. Matches the install path. */
const SUPPORTED_NETWORKS = new Set(["bridge", "host", "none"]);

/** Config types we can turn back into docker arguments. */
const SUPPORTED_CONFIG_TYPES = new Set<CaConfigType>(["Port", "Path", "Variable", "Label"]);

/**
 * Elements a docker-manager template may carry. Most are metadata the WebGUI
 * shows and docker never sees. An element outside this list that carries text
 * is refused rather than ignored: it may well be something that changes how the
 * container runs, and rebuilding without it would quietly produce a different
 * container.
 */
const KNOWN_ELEMENTS = new Set([
  "Author", "Banner", "Base", "Beta", "Blacklist", "Branch", "CABlacklist", "CAComment",
  "Category", "Changes", "Config", "Contributions", "CPUset", "Data", "Date", "DateInstalled",
  "Description", "DonateLink", "DonateText", "Downloads", "Environment", "ExtraParams",
  "ExtraSearchTerms", "FirstSeen", "GitHub", "Icon", "Language", "LastUpdate", "Licence",
  "ExtraNetworks", "License", "Maintainer", "MaxVer", "Memory", "MinVer", "ModeratorComment", "MyIP", "Name", "Network",
  "Networking", "Official", "OriginalOverview", "Overview", "Plugin", "PostArgs", "Privileged",
  "Project", "ReadMe", "Registry", "Repo", "Repository", "Requires", "Screenshot", "Shell",
  "Stars", "Support", "TailscaleEnabled", "TemplatePath", "TemplateURL", "Version", "WebUI",
  "Weblink",
]);

/**
 * Elements that change how the container runs and that this module cannot
 * reproduce. A non-empty one is a refusal, never a silent drop.
 */
const MUST_BE_EMPTY: Array<{ element: string; code: string; message: string }> = [
  {
    element: "ExtraParams",
    code: "CA_EXTRA_PARAMS",
    message:
      "The saved template sets Extra Parameters, which Unraid passes to the shell unescaped and UnraidClaw will not reproduce. Use the Docker tab for this app.",
  },
  {
    element: "PostArgs",
    code: "CA_POST_ARGS",
    message:
      "The saved template sets Post Arguments, which Unraid passes to the shell unescaped and UnraidClaw will not reproduce. Use the Docker tab for this app.",
  },
  {
    element: "CPUset",
    code: "CA_CPUSET",
    message: "The saved template pins the container to specific CPUs, which UnraidClaw does not reproduce. Use the Docker tab for this app.",
  },
  {
    element: "MyIP",
    code: "CA_CUSTOM_IP",
    message: "The saved template assigns the container a fixed IP on a custom network, which UnraidClaw does not reproduce. Use the Docker tab for this app.",
  },
  {
    element: "ExtraNetworks",
    code: "CA_EXTRA_NETWORKS",
    message: "The saved template attaches the container to additional networks, which UnraidClaw does not reproduce. Use the Docker tab for this app.",
  },
  {
    element: "Networking",
    code: "CA_LEGACY_TEMPLATE",
    message: "The saved template stores its ports in the old <Networking> format, which UnraidClaw does not read. Use the Docker tab for this app.",
  },
  {
    element: "Data",
    code: "CA_LEGACY_TEMPLATE",
    message: "The saved template stores its volumes in the old <Data> format, which UnraidClaw does not read. Use the Docker tab for this app.",
  },
  {
    element: "Environment",
    code: "CA_LEGACY_TEMPLATE",
    message: "The saved template stores its variables in the old <Environment> format, which UnraidClaw does not read. Use the Docker tab for this app.",
  },
];

export interface SavedTemplate {
  /** Absolute path the XML was read from. */
  path: string;
  /** Exactly the bytes on flash. Never rewritten by update or remove. */
  xml: string;
  /** Name, image, network and the derived port/volume/env lists. */
  resolved: ResolvedTemplate;
  /** `key=value` for every Label config entry. */
  labels: string[];
  registry: string;
  webui: string;
  icon: string;
  /** The `--memory` value as written (Unraid 7.4+), or "" when there is no limit. */
  memory: string;
  /** That limit in bytes, 0 when there is none. */
  memoryBytes: number;
  /** Everything about this template that stops UnraidClaw from rebuilding it. */
  blockers: CaBlocker[];
}

/** Docker refuses a memory limit below 6 MB. */
const DOCKER_MIN_MEMORY = 6 * 1024 * 1024;

/**
 * Bytes for a memory size, read the way docker reads `--memory`: a number with
 * an optional binary unit (`512m`, `2g`, `1.5GiB`, `2 g`). Null when docker
 * would reject it.
 */
export function parseMemoryBytes(value: string): number | null {
  const m = /^(\d+(?:\.\d*)?) ?(?:([kmgtp])(?:i?b)?|b)?$/i.exec(value);
  if (!m) return null;
  const power = m[2] ? "kmgtp".indexOf(m[2].toLowerCase()) + 1 : 0;
  return Math.floor(Number(m[1]) * 1024 ** power);
}

function boolText(value: string): boolean {
  return value.trim().toLowerCase() === "true";
}

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

/**
 * Parse a saved docker-manager template.
 *
 * Structural problems (not XML, no `<Container>`, no name, no image) throw,
 * because there is nothing to act on. Everything else that makes the app
 * unsuitable for an automated rebuild comes back in `blockers`, so the caller
 * can report all of them at once.
 */
export function parseSavedTemplate(xml: string, path: string): SavedTemplate {
  let doc: Record<string, unknown>;
  try {
    doc = parseXmlDocument(xml, { alwaysArray: ["Config"] });
  } catch (err) {
    if (err instanceof XmlParseError) {
      throw new CaInstallError(`${path} could not be read: ${err.message}`, "CA_TEMPLATE_UNREADABLE", 422);
    }
    throw err;
  }

  const container = doc.Container;
  if (container === undefined || container === null || typeof container !== "object" || Array.isArray(container)) {
    throw new CaInstallError(
      `${path} is not an Unraid docker template: it has no single <Container> element.`,
      "CA_TEMPLATE_UNREADABLE",
      422
    );
  }
  const root = container as Record<string, unknown>;

  const blockers: CaBlocker[] = [];
  const add = (code: string, message: string) => {
    if (!blockers.some((b) => b.code === code && b.message === message)) blockers.push({ code, message });
  };

  // Metadata is trimmed; configured values are not. The parser keeps text
  // exactly as written so a path or variable with a deliberate trailing space
  // survives an update, but a name or an image reference with a stray newline
  // around it is the same name.
  const meta = (node: unknown) => textOf(node).trim();
  const name = meta(root.Name);
  const image = meta(root.Repository);
  if (name === "") {
    throw new CaInstallError(`${path} has no <Name>, so it describes no container.`, "CA_TEMPLATE_UNREADABLE", 422);
  }
  if (image === "") {
    throw new CaInstallError(`${path} has no <Repository>, so it names no Docker image.`, "CA_TEMPLATE_UNREADABLE", 422);
  }
  // Unraid interpolates Name raw into a shell string of its own, and we pass it
  // to docker ourselves. A name outside the grammar is refused, never rewritten.
  if (!CA_NAME_RE.test(name)) {
    add(
      "CA_UNSAFE_NAME",
      `The saved template's name ${JSON.stringify(name)} is not a valid Docker container name.`
    );
  }

  for (const key of Object.keys(root)) {
    if (key.startsWith("@_") || key === "#text") continue;
    if (KNOWN_ELEMENTS.has(key)) continue;
    const hasContent = asArray(root[key] as unknown).some((v) => meta(v) !== "" || (v !== null && typeof v === "object"));
    if (hasContent) {
      add(
        "CA_UNSUPPORTED_TEMPLATE_FIELD",
        `The saved template has a <${key}> element UnraidClaw does not understand, so rebuilding the container would leave it out.`
      );
    }
  }

  for (const rule of MUST_BE_EMPTY) {
    const nodes = asArray(root[rule.element] as unknown);
    const present = nodes.some((n) => meta(n) !== "" || (n !== null && typeof n === "object" && Object.keys(n as object).length > 0));
    if (present) add(rule.code, rule.message);
  }

  if (boolText(meta(root.Privileged))) {
    add("CA_PRIVILEGED", "The saved template runs the container privileged, giving it full host access. UnraidClaw will not rebuild it.");
  }
  if (boolText(meta(root.TailscaleEnabled))) {
    add("CA_TAILSCALE", "The saved template uses Unraid's Tailscale container hook, which UnraidClaw does not set up.");
  }

  const network = (meta(root.Network) || "bridge").toLowerCase();
  if (!SUPPORTED_NETWORKS.has(network)) {
    add(
      "CA_UNSUPPORTED_NETWORK",
      `The saved template uses the custom network "${meta(root.Network)}". UnraidClaw only rebuilds containers on bridge, host or none.`
    );
  }

  // Unraid 7.4 writes <Memory> into every template and passes it as --memory
  // when it is set. "0" is docker's own spelling of no limit.
  let memory = meta(root.Memory);
  let memoryBytes = 0;
  if (memory !== "") {
    const bytes = parseMemoryBytes(memory);
    if (bytes === null) {
      add("CA_INVALID_MEMORY", `The saved template's memory limit ${JSON.stringify(memory)} is not a size docker accepts.`);
    } else if (bytes > 0 && bytes < DOCKER_MIN_MEMORY) {
      add("CA_INVALID_MEMORY", `The saved template's memory limit ${JSON.stringify(memory)} is below docker's 6 MB minimum.`);
    } else {
      memoryBytes = bytes;
    }
    if (memoryBytes === 0) memory = "";
  }

  const ports: string[] = [];
  const volumes: string[] = [];
  const env: string[] = [];
  const labels: string[] = [];
  const config: Array<CaConfigEntry & { value: string }> = [];

  for (const node of asArray(root.Config as unknown)) {
    const type = attrOf(node, "Type").trim();
    const target = attrOf(node, "Target").trim();
    const fallback = attrOf(node, "Default");
    // Unraid's xmlToVar takes the element text and falls back to the Default
    // attribute only when that text is empty, so an override that cleared a
    // field has to keep both sides empty. We read it back the same way.
    const text = textOf(node);
    const value = text.trim() !== "" ? text : fallback;
    const label = attrOf(node, "Name") || target;

    if (!SUPPORTED_CONFIG_TYPES.has(type as CaConfigType)) {
      add(
        type === "Device" ? "CA_DEVICE_PASSTHROUGH" : "CA_UNSUPPORTED_CONFIG",
        type === "Device"
          ? `The saved template passes the host device "${value || target}" through to the container, which UnraidClaw does not reproduce.`
          : `The saved template has a "${type || "(missing)"}" field (${label}) UnraidClaw does not understand, so rebuilding the container would leave it out.`
      );
      continue;
    }
    if (hasControlChars(value) || hasControlChars(target)) {
      add("CA_INVALID_VALUE", `The saved value for "${label}" contains a control character.`);
      continue;
    }

    const entry: CaConfigEntry & { value: string } = {
      name: attrOf(node, "Name"),
      target,
      type: type as CaConfigType,
      default: fallback,
      mode: attrOf(node, "Mode"),
      description: attrOf(node, "Description"),
      required: boolText(attrOf(node, "Required")),
      mask: boolText(attrOf(node, "Mask")),
      value,
    };
    config.push(entry);

    if (value.trim() === "" || target.trim() === "") continue;
    switch (entry.type) {
      case "Path":
        volumes.push(`${value}:${target}:${entry.mode}`);
        break;
      case "Port":
        if (network === "bridge") ports.push(`${value}:${target}/${entry.mode}`);
        else if (network === "host") env.push(`${entry.mode.toUpperCase()}_PORT_${target}=${value}`);
        // network "none": Unraid publishes nothing.
        break;
      case "Variable":
        env.push(`${target}=${value}`);
        break;
      case "Label":
        labels.push(`${target}=${value}`);
        break;
    }
  }

  return {
    path,
    xml,
    resolved: { name, image, network, ports, volumes, env, config },
    labels,
    registry: meta(root.Registry),
    webui: meta(root.WebUI),
    icon: meta(root.Icon),
    memory,
    memoryBytes,
    blockers,
  };
}

/**
 * Compare two image references the way docker does, so that `jellyfin/jellyfin`
 * and `docker.io/jellyfin/jellyfin:latest` are recognized as the same image.
 */
export function normalizeImage(ref: string): string {
  let out = ref.trim();
  if (out === "") return out;
  out = out.replace(/^docker\.io\/(library\/)?/, "");
  if (out.includes("@")) return out;
  const lastSlash = out.lastIndexOf("/");
  const lastColon = out.lastIndexOf(":");
  if (lastColon <= lastSlash) out += ":latest";
  return out;
}

/** One entry of the container's `Mounts` array. */
export interface ContainerMount {
  /** "bind", "volume", "tmpfs", ... */
  type: string;
  /** Volume name for a volume mount (a 64-hex id when the volume is anonymous). */
  name: string;
  /** Host path for a bind mount. */
  source: string;
  destination: string;
  rw: boolean;
  /** The mode docker recorded, e.g. "rw", "z", or empty. */
  mode: string;
}

/** The parts of `docker inspect` on a container that this module acts on. */
export interface ContainerFacts {
  id: string;
  name: string;
  /** The image reference the container was created from, e.g. "jellyfin/jellyfin:latest". */
  image: string;
  /** The resolved image id the container is actually running. */
  imageId: string;
  running: boolean;
  /** `State.Status`: created, running, paused, restarting, removing, exited, dead. */
  status: string;
  /** True while the container is in a state an update cannot reason about. */
  unstable: boolean;
  /** `--restart` as docker would take it back, or null when none was set. */
  restart: string | null;
  /** `--pids-limit`, or null when unset. */
  pidsLimit: number | null;
  labels: Record<string, string>;
  mounts: ContainerMount[];
  /** Names of the volumes attached. Never removed by update or remove. */
  volumes: string[];
  /** Host directories bind-mounted into the container. Never touched either. */
  binds: string[];
}

/**
 * States an update refuses to act on.
 *
 * A paused container that came back running, or a container caught in a
 * restart loop, would be reported as a successful update into a state nobody
 * asked for. Removal is less delicate: it can stop a paused container.
 */
const UNSTABLE_STATES = new Set(["restarting", "removing", "dead", "paused"]);

/* eslint-disable @typescript-eslint/no-explicit-any */

export function parseContainerFacts(raw: string): ContainerFacts {
  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new CaInstallError("docker inspect returned something that is not JSON.", "CA_DOCKER_UNREADABLE", 500);
  }
  const inspect = Array.isArray(doc) ? doc[0] : doc;
  if (!inspect || typeof inspect !== "object" || typeof inspect.Id !== "string") {
    throw new CaInstallError("docker inspect returned no container.", "CA_DOCKER_UNREADABLE", 500);
  }

  const policy = inspect.HostConfig?.RestartPolicy ?? {};
  let restart: string | null = null;
  if (typeof policy.Name === "string" && policy.Name !== "" && policy.Name !== "no") {
    restart =
      policy.Name === "on-failure" && Number(policy.MaximumRetryCount) > 0
        ? `on-failure:${Number(policy.MaximumRetryCount)}`
        : policy.Name;
  }

  const pids = Number(inspect.HostConfig?.PidsLimit ?? 0);

  const mounts: ContainerMount[] = (Array.isArray(inspect.Mounts) ? inspect.Mounts : []).map((m: any) => ({
    type: String(m?.Type ?? ""),
    name: String(m?.Name ?? ""),
    source: String(m?.Source ?? ""),
    destination: String(m?.Destination ?? ""),
    rw: m?.RW !== false,
    mode: String(m?.Mode ?? ""),
  }));

  const state = inspect.State ?? {};
  const status = String(state.Status ?? (state.Running === true ? "running" : "exited"));

  return {
    id: inspect.Id,
    name: String(inspect.Name ?? "").replace(/^\//, ""),
    image: String(inspect.Config?.Image ?? ""),
    imageId: String(inspect.Image ?? ""),
    running: state.Running === true,
    status,
    unstable:
      UNSTABLE_STATES.has(status) || state.Paused === true || state.Restarting === true || state.Dead === true,
    restart,
    pidsLimit: Number.isFinite(pids) && pids > 0 ? pids : null,
    labels: (inspect.Config?.Labels ?? {}) as Record<string, string>,
    mounts,
    volumes: mounts.filter((m) => m.type === "volume" && m.name).map((m) => m.name),
    binds: mounts.filter((m) => m.type === "bind" && m.source).map((m) => m.source),
  };
}

/**
 * Work out which of the live container's mounts the candidate has to be given
 * back explicitly.
 *
 * A destination the template maps is the template's business. Everything else
 * attached to the running container is data: an anonymous volume docker created
 * from the image's own `VOLUME`, or a named volume somebody attached by hand.
 * Recreating without them does not lose the volume, but it does hand the app a
 * brand new empty one and leave the old data orphaned, which looks exactly like
 * data loss to the person running it. Those are carried over by name. A mount
 * this module cannot reproduce faithfully is a refusal instead.
 */
export function reconcileMounts(
  tpl: SavedTemplate,
  mounts: ContainerMount[]
): { volumeArgs: string[]; blockers: CaBlocker[] } {
  const templated = new Set(
    tpl.resolved.config.filter((c) => c.type === "Path" && c.target.trim() !== "").map((c) => c.target)
  );
  const volumeArgs: string[] = [];
  const blockers: CaBlocker[] = [];

  for (const mount of mounts) {
    if (templated.has(mount.destination)) continue;

    if (mount.type === "volume" && mount.name !== "") {
      if (mount.name.includes(":") || mount.destination.includes(":")) {
        blockers.push({
          code: "CA_LIVE_MOUNT_UNSUPPORTED",
          message: `The volume mounted at "${mount.destination}" has a name UnraidClaw cannot pass to docker safely.`,
        });
        continue;
      }
      volumeArgs.push(`${mount.name}:${mount.destination}:${mount.rw ? "rw" : "ro"}`);
      continue;
    }

    blockers.push({
      code: "CA_LIVE_MOUNT_UNSUPPORTED",
      message:
        mount.type === "bind"
          ? `The installed container bind-mounts "${mount.source}" at "${mount.destination}", which the saved template does not describe. UnraidClaw will not recreate it.`
          : `The installed container has a "${mount.type || "unknown"}" mount at "${mount.destination}", which UnraidClaw does not reproduce.`,
    });
  }

  return { volumeArgs, blockers };
}

function sameList(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (Array.isArray(v) ? v.map(String) : v === null || v === undefined ? [] : [String(v)]);
  const x = norm(a);
  const y = norm(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Everything the running container has that a rebuild from the saved template
 * would not reproduce.
 *
 * `docker inspect` on a container reports the image's own defaults as if they
 * were the container's, so entrypoint, command, user and working directory are
 * compared against the image the container was created from — the old one, not
 * the freshly pulled one, whose defaults may legitimately differ. Anything that
 * diverges came from somewhere this module cannot see (Extra Parameters, a
 * hand-run docker command), and is a refusal rather than a silent loss.
 */
export function containerBlockers(
  rawContainer: string,
  rawImage: string | null,
  templateNetwork = "",
  templateMemory = 0
): CaBlocker[] {
  const blockers: CaBlocker[] = [];
  const add = (code: string, message: string) => blockers.push({ code, message });

  let inspect: any;
  try {
    const doc = JSON.parse(rawContainer);
    inspect = Array.isArray(doc) ? doc[0] : doc;
  } catch {
    return [{ code: "CA_DOCKER_UNREADABLE", message: "docker inspect returned something that is not JSON." }];
  }

  const host = inspect.HostConfig ?? {};
  const config = inspect.Config ?? {};

  if (host.Privileged === true) {
    add("CA_LIVE_PRIVILEGED", "The installed container runs privileged. UnraidClaw will not recreate it.");
  }
  for (const [field, code, what] of [
    ["Devices", "CA_LIVE_DEVICES", "passes host devices through"],
    ["DeviceRequests", "CA_LIVE_DEVICE_REQUESTS", "requests host devices such as a GPU"],
    ["CapAdd", "CA_LIVE_CAPABILITIES", "adds Linux capabilities"],
    ["CapDrop", "CA_LIVE_CAPABILITIES", "drops Linux capabilities"],
    ["ExtraHosts", "CA_LIVE_EXTRA_HOSTS", "sets extra /etc/hosts entries"],
    ["SecurityOpt", "CA_LIVE_SECURITY_OPT", "sets security options"],
  ] as const) {
    const value = host[field];
    if (Array.isArray(value) && value.length > 0) {
      add(code, `The installed container ${what}, which the saved template does not describe. UnraidClaw will not recreate it.`);
    }
  }
  // Resource limits and namespace settings docker reports as zero or empty
  // when they were never set. A non-default value came from somewhere the
  // template does not describe, and recreating without it would quietly hand
  // the app the whole machine, or a writable root it was denied.
  // The one exception is a memory limit the template itself sets, which the
  // rebuild passes back as --memory. Docker then records swap as twice the
  // limit, so that is the only swap value recreating reproduces.
  const liveMemory = Number(host.Memory ?? 0);
  if (liveMemory !== templateMemory) {
    add(
      "CA_LIVE_MEMORY_LIMIT",
      templateMemory === 0
        ? "The installed container has a memory limit, which the saved template does not describe. UnraidClaw will not recreate it."
        : "The installed container's memory limit does not match the one its saved template sets. UnraidClaw will not recreate it."
    );
  } else if (Number(host.MemorySwap ?? 0) !== liveMemory * 2) {
    add("CA_LIVE_MEMORY_LIMIT", "The installed container has a swap limit, which the saved template does not describe. UnraidClaw will not recreate it.");
  }
  for (const [field, code, what] of [
    ["MemoryReservation", "CA_LIVE_MEMORY_LIMIT", "has a memory reservation"],
    ["NanoCpus", "CA_LIVE_CPU_LIMIT", "has a CPU limit"],
    ["CpuQuota", "CA_LIVE_CPU_LIMIT", "has a CPU quota"],
    ["CpuPeriod", "CA_LIVE_CPU_LIMIT", "has a CPU period"],
    ["CpuShares", "CA_LIVE_CPU_LIMIT", "has a CPU share weight"],
  ] as const) {
    if (Number(host[field] ?? 0) !== 0) {
      add(code, `The installed container ${what}, which the saved template does not describe. UnraidClaw will not recreate it.`);
    }
  }
  if (host.ReadonlyRootfs === true) {
    add("CA_LIVE_READONLY_ROOTFS", "The installed container runs with a read-only root filesystem, which the saved template does not describe. UnraidClaw will not recreate it.");
  }
  if (host.PublishAllPorts === true) {
    add("CA_LIVE_PUBLISH_ALL", "The installed container publishes all of its ports, which the saved template does not describe. UnraidClaw will not recreate it.");
  }
  for (const [field, code, what] of [
    ["CpusetCpus", "CA_LIVE_CPUSET", "is pinned to specific CPUs"],
    ["CpusetMems", "CA_LIVE_CPUSET", "is pinned to specific memory nodes"],
    ["PidMode", "CA_LIVE_NAMESPACE", "shares another process namespace"],
    ["UsernsMode", "CA_LIVE_NAMESPACE", "uses a user namespace setting"],
    ["UTSMode", "CA_LIVE_NAMESPACE", "uses a UTS namespace setting"],
    ["CgroupParent", "CA_LIVE_NAMESPACE", "is in a custom cgroup"],
  ] as const) {
    if (String(host[field] ?? "") !== "") {
      add(code, `The installed container ${what}, which the saved template does not describe. UnraidClaw will not recreate it.`);
    }
  }
  if (String(host.IpcMode ?? "") !== "" && !["private", "shareable"].includes(String(host.IpcMode))) {
    add("CA_LIVE_NAMESPACE", `The installed container uses the "${host.IpcMode}" IPC mode, which the saved template does not describe. UnraidClaw will not recreate it.`);
  }
  for (const [field, code, what] of [
    ["Dns", "CA_LIVE_DNS", "sets its own DNS servers"],
    ["DnsSearch", "CA_LIVE_DNS", "sets its own DNS search domains"],
    ["DnsOptions", "CA_LIVE_DNS", "sets its own DNS options"],
    ["VolumesFrom", "CA_LIVE_VOLUMES_FROM", "inherits volumes from another container"],
    ["GroupAdd", "CA_LIVE_GROUPS", "adds supplementary groups"],
    ["Ulimits", "CA_LIVE_ULIMITS", "sets ulimits"],
    ["Links", "CA_LIVE_LINKS", "is linked to another container"],
  ] as const) {
    const value = host[field];
    if (Array.isArray(value) && value.length > 0) {
      add(code, `The installed container ${what}, which the saved template does not describe. UnraidClaw will not recreate it.`);
    }
  }
  if (host.Tmpfs && Object.keys(host.Tmpfs).length > 0) {
    add("CA_LIVE_TMPFS", "The installed container has tmpfs mounts, which the saved template does not describe. UnraidClaw will not recreate it.");
  }
  const shm = Number(host.ShmSize ?? 0);
  if (shm !== 0 && shm !== 67108864) {
    add("CA_LIVE_SHM_SIZE", "The installed container has a custom /dev/shm size, which the saved template does not describe. UnraidClaw will not recreate it.");
  }
  const networkMode = String(host.NetworkMode ?? "").toLowerCase();
  if (networkMode !== "" && templateNetwork !== "" && networkMode !== templateNetwork) {
    add(
      "CA_LIVE_NETWORK_MISMATCH",
      `The installed container is on the "${networkMode}" network but its template says "${templateNetwork}". UnraidClaw will not move it.`
    );
  }
  if (host.Sysctls && Object.keys(host.Sysctls).length > 0) {
    add("CA_LIVE_SYSCTLS", "The installed container sets sysctls, which the saved template does not describe. UnraidClaw will not recreate it.");
  }
  if (typeof host.Runtime === "string" && host.Runtime !== "" && host.Runtime !== "runc") {
    add("CA_LIVE_RUNTIME", `The installed container uses the "${host.Runtime}" runtime, which the saved template does not describe. UnraidClaw will not recreate it.`);
  }
  const networks = Object.keys(inspect.NetworkSettings?.Networks ?? {});
  if (networks.length > 1) {
    add("CA_LIVE_MULTI_NETWORK", `The installed container is attached to ${networks.length} networks. UnraidClaw only recreates single-network containers.`);
  }

  if (rawImage) {
    let imageConfig: any = {};
    try {
      const doc = JSON.parse(rawImage);
      imageConfig = (Array.isArray(doc) ? doc[0] : doc)?.Config ?? {};
    } catch {
      imageConfig = {};
    }
    if (!sameList(config.Entrypoint, imageConfig.Entrypoint)) {
      add("CA_LIVE_ENTRYPOINT", "The installed container overrides the image's entrypoint, which the saved template does not describe. UnraidClaw will not recreate it.");
    }
    if (!sameList(config.Cmd, imageConfig.Cmd)) {
      add("CA_LIVE_COMMAND", "The installed container overrides the image's command, which the saved template does not describe. UnraidClaw will not recreate it.");
    }
    if (String(config.User ?? "") !== String(imageConfig.User ?? "")) {
      add("CA_LIVE_USER", "The installed container runs as a different user than the image specifies, which the saved template does not describe. UnraidClaw will not recreate it.");
    }
    if (String(config.WorkingDir ?? "") !== String(imageConfig.WorkingDir ?? "")) {
      add("CA_LIVE_WORKDIR", "The installed container overrides the image's working directory, which the saved template does not describe. UnraidClaw will not recreate it.");
    }
  }

  return blockers;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

export interface CreateOptions {
  /** Name to create the container under, which is not yet the final name. */
  createName: string;
  /** Unraid's configured timezone, from var.ini. Null when unknown. */
  timeZone: string | null;
  /** The server's name, from var.ini. Null when unknown. */
  hostName: string | null;
  /** Carried over from the container being replaced. */
  restart: string | null;
  pidsLimit: number | null;
  /** `name:destination:mode` for volumes the live container has and the template does not. */
  extraVolumes?: string[];
}

/**
 * Values the template marks as secrets, longest first so a value that contains
 * another is replaced before its substring is.
 */
export function maskedValues(tpl: SavedTemplate): string[] {
  return tpl.resolved.config
    .filter((c) => c.mask && c.value.trim() !== "")
    .map((c) => c.value)
    .sort((a, b) => b.length - a.length);
}

/**
 * Replace every masked value with `***`.
 *
 * The plan, the command preview and any error text go back to the caller and
 * into the activity log, and a template's masked fields are its passwords and
 * API keys. The runner still gets the real values; only what is reported is
 * redacted.
 */
export function redactSecrets(secrets: string[], text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("***");
  return out;
}

export function redactArgv(secrets: string[], argv: string[]): string[] {
  return argv.map((arg) => redactSecrets(secrets, arg));
}

/**
 * The `docker create` argv for rebuilding this template's container.
 *
 * Mirrors what Unraid's xmlToCommand builds from the same template, with two
 * deliberate differences: it is an argv rather than a shell string, and the
 * container is created rather than run, so the caller decides when — and
 * whether — it starts.
 *
 * `HOST_CONTAINERNAME` is the template's name even when the container is
 * created under a temporary one, because that is the name the app will have by
 * the time it starts.
 */
export function buildCreateArgs(tpl: SavedTemplate, o: CreateOptions): string[] {
  const { resolved } = tpl;
  const argv = ["create", "--name", o.createName, "--net", resolved.network];
  if (o.pidsLimit !== null) argv.push("--pids-limit", String(o.pidsLimit));
  if (o.restart !== null) argv.push("--restart", o.restart);
  if (tpl.memory) argv.push("--memory", tpl.memory);

  const declares = (key: string) => resolved.env.some((e) => e.startsWith(`${key}=`));
  if (o.timeZone && !declares("TZ")) argv.push("-e", `TZ=${o.timeZone}`);
  if (!declares("HOST_OS")) argv.push("-e", "HOST_OS=Unraid");
  if (o.hostName && !declares("HOST_HOSTNAME")) argv.push("-e", `HOST_HOSTNAME=${o.hostName}`);
  if (!declares("HOST_CONTAINERNAME")) argv.push("-e", `HOST_CONTAINERNAME=${resolved.name}`);
  for (const e of resolved.env) argv.push("-e", e);

  argv.push("-l", "net.unraid.docker.managed=dockerman");
  if (tpl.webui) argv.push("-l", `net.unraid.docker.webui=${tpl.webui}`);
  if (tpl.icon) argv.push("-l", `net.unraid.docker.icon=${tpl.icon}`);
  for (const l of tpl.labels) argv.push("-l", l);

  for (const p of resolved.ports) argv.push("-p", p);
  for (const v of resolved.volumes) argv.push("-v", v);
  // Volumes the live container already has that the template says nothing
  // about, so the app keeps the data it has been writing rather than getting a
  // fresh empty volume.
  for (const v of o.extraVolumes ?? []) argv.push("-v", v);

  argv.push(resolved.image);
  return argv;
}
