// Turning a Community Applications catalog entry into an Unraid docker-manager
// template.
//
// Security note. Unraid's own installer re-reads this template in PHP and
// concatenates its fields into a single string that is handed to `popen()`,
// i.e. to `/bin/sh -c`. Most fields go through escapeshellarg() first, but
// `Name` is additionally interpolated raw into
// `HOST_CONTAINERNAME="<Name>"` (dynamix.docker.manager Helpers.php), and
// `ExtraParams`/`PostArgs` are raw by design. The catalog is third-party,
// user-submitted content, so it is treated as untrusted:
//
//   - the container name must match a strict allowlist, or the install is
//     refused rather than silently rewritten,
//   - templates carrying ExtraParams or PostArgs are refused outright,
//   - control characters anywhere in a resolved value are refused,
//   - every value written into the XML is entity-encoded exactly once.

import type { CaBlocker, CaConfigEntry, CaInstallPlan } from "@unraidclaw/shared";
import type { CaApp } from "./ca-feed.js";
import { escapeXml } from "./docker-common.js";

/**
 * Docker's own container-name grammar, which also excludes every character
 * that could break out of the unescaped `HOST_CONTAINERNAME="..."` shell
 * interpolation upstream. Names are rejected, never rewritten.
 */
export const CA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

/** Networks whose behavior we can predict exactly from the template alone. */
const SUPPORTED_NETWORKS = new Set(["bridge", "host", "none"]);

/**
 * Control characters break the docker arguments Unraid builds from a template,
 * and NUL truncates them. Values carrying one are rejected, not stripped.
 */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

/** Docker refuses a memory limit below 6 MB. */
export const DOCKER_MIN_MEMORY = 6 * 1024 * 1024;

/**
 * The largest limit this can vouch for.
 *
 * Docker holds `--memory` in a signed 64-bit integer, whose maximum is far
 * beyond what a JavaScript number counts exactly. Rather than report a byte
 * count that has already been rounded, reject anything over 2^53-1 bytes.
 */
const MAX_REPRESENTABLE_MEMORY = Number.MAX_SAFE_INTEGER;

type MemorySize = { bytes: number } | "unreadable" | "out-of-range";

/**
 * Bytes for a memory size, read the way docker reads `--memory`: a number with
 * an optional binary unit (`512m`, `2g`, `1.5GiB`, `2 g`).
 *
 * The digit run is unbounded, so `Number()` on it can reach Infinity; every
 * result is therefore checked for being a finite integer in range before it is
 * handed back as a byte count.
 */
function parseMemorySize(value: string): MemorySize {
  const m = /^(\d+(?:\.\d*)?) ?(?:([kmgtp])(?:i?b)?|b)?$/i.exec(value);
  if (!m) return "unreadable";
  const power = m[2] ? "kmgtp".indexOf(m[2].toLowerCase()) + 1 : 0;
  const bytes = Math.floor(Number(m[1]) * 1024 ** power);
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_REPRESENTABLE_MEMORY) {
    return "out-of-range";
  }
  return { bytes };
}

/**
 * Bytes for a memory size docker would accept, or null when it would not. A
 * size too large to count exactly is null as well, never a rounded number.
 */
export function parseMemoryBytes(value: string): number | null {
  const size = parseMemorySize(value);
  return typeof size === "string" ? null : size.bytes;
}

export type MemoryLimit =
  | { ok: true; memory: string; bytes: number }
  | { ok: false; reason: "unreadable" | "out-of-range" | "below-minimum" };

/**
 * Read an Unraid 7.4 `<Memory>` value the one way both the install and the
 * update path agree on.
 *
 * Unraid writes this element into every template it saves and passes it
 * through verbatim as `--memory=`, without checking it first, so a value
 * docker rejects turns into a container that never gets created. Empty is the
 * normal case (no limit), and so is docker's own spelling of no limit, "0":
 * both normalize to an empty limit rather than an error, which is what keeps a
 * template written here readable by the update path unchanged.
 */
export function normalizeMemoryLimit(value: string): MemoryLimit {
  const memory = value.trim();
  if (memory === "") return { ok: true, memory: "", bytes: 0 };
  const size = parseMemorySize(memory);
  if (typeof size === "string") return { ok: false, reason: size };
  if (size.bytes === 0) return { ok: true, memory: "", bytes: 0 };
  if (size.bytes < DOCKER_MIN_MEMORY) return { ok: false, reason: "below-minimum" };
  return { ok: true, memory, bytes: size.bytes };
}

/** Why a limit was refused, as the second half of a sentence about it. */
export function memoryLimitProblem(reason: (MemoryLimit & { ok: false })["reason"]): string {
  switch (reason) {
    case "unreadable":
      return "is not a size docker accepts";
    case "out-of-range":
      return "is too large for UnraidClaw to represent safely";
    case "below-minimum":
      return "is below docker's 6 MB minimum";
  }
}

export class CaInstallError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CaInstallError";
  }
}

export interface TemplateEnv {
  /** Contents of /etc/unraid-version, e.g. "7.0.0". Null when unknown. */
  unraidVersion: string | null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function cleanVersion(v: string): string {
  const m = /(\d+(?:\.\d+)*)/.exec(v.replace(/^"|"$/g, ""));
  return m ? m[1] : "";
}

/**
 * Everything that makes an app un-installable through this API.
 *
 * Each of these is a case where a plain template plus Unraid's docker manager
 * would either run something we cannot vouch for, or would silently produce a
 * container that does not match the template. We refuse instead of installing
 * something different from what was asked for.
 */
export function computeBlockers(app: CaApp, env: TemplateEnv): CaBlocker[] {
  const raw = app.raw;
  const blockers: CaBlocker[] = [];
  const add = (code: string, message: string) => blockers.push({ code, message });

  if (app.isPlugin) {
    add("CA_PLUGIN_ENTRY", "This is an Unraid plugin (.plg), not a Docker container. Install it from the Plugins page.");
  }
  if (app.deprecated) {
    add("CA_DEPRECATED", "The maintainer has marked this template deprecated.");
  }
  if (raw.Blacklist === true || String(raw.Blacklist ?? "").toLowerCase() === "true" ||
      raw.CABlacklist === true || String(raw.CABlacklist ?? "").toLowerCase() === "true") {
    add("CA_BLACKLISTED", "Community Applications has blacklisted this template.");
  }
  if (!app.repository) {
    add("CA_NO_IMAGE", "The template names no Docker image.");
  }
  if ((raw.ExtraParams ?? "").trim() !== "") {
    add(
      "CA_EXTRA_PARAMS",
      "The template sets Extra Parameters, which Unraid passes to the shell unescaped. Install this app from the Unraid WebGUI instead."
    );
  }
  if ((raw.PostArgs ?? "").trim() !== "") {
    add(
      "CA_POST_ARGS",
      "The template sets Post Arguments, which Unraid passes to the shell unescaped. Install this app from the Unraid WebGUI instead."
    );
  }
  if (String(raw.Privileged ?? "").toLowerCase() === "true") {
    add("CA_PRIVILEGED", "The template requests a privileged container, which grants it full host access.");
  }
  if (String(raw.TailscaleEnabled ?? "").toLowerCase() === "true") {
    add("CA_TAILSCALE", "The template needs Unraid's Tailscale container hook, which UnraidClaw does not set up.");
  }
  if ((raw.MyMAC ?? "").trim() !== "") {
    add("CA_CUSTOM_MAC", "The template pins a MAC address, which only works on macvlan/ipvlan networks.");
  }
  // Unraid 7.4 attaches these with `docker network connect` after the
  // container exists, a second step UnraidClaw does not run. Installing anyway
  // would produce a container on one network instead of the several the
  // template asks for. The update path refuses the same element for the same
  // reason (CA_EXTRA_NETWORKS in ca-saved-template).
  if (String(raw.ExtraNetworks ?? "").trim() !== "") {
    add(
      "CA_EXTRA_NETWORKS",
      "The template attaches the container to additional networks, which UnraidClaw does not reproduce. Install this app from the Unraid WebGUI instead."
    );
  }
  // Unraid 7.4 hands <Memory> to docker as `--memory=` without checking it, so
  // a value docker rejects becomes a container that is never created. Refuse
  // it here instead, while the template is still only a plan.
  const memory = String(raw.Memory ?? "").trim();
  if (memory !== "") {
    const limit = normalizeMemoryLimit(memory);
    if (!limit.ok) {
      add(
        "CA_INVALID_MEMORY",
        `The template's memory limit ${JSON.stringify(memory)} ${memoryLimitProblem(limit.reason)}.`
      );
    } else if (limit.bytes > 0) {
      // <Memory> reached the docker manager in 7.4. On 7.0 through 7.3 its
      // Helpers.php names the element nowhere and its command builder has no
      // --memory at all (unraid/webgui, branches 7.0-7.3 against master), so
      // installing here would produce a container with no limit while the
      // template claimed one.
      const have = env.unraidVersion ? cleanVersion(env.unraidVersion) : "";
      if (!have) {
        add(
          "CA_MEMORY_UNSUPPORTED",
          "The template sets a memory limit, which only Unraid 7.4 and newer apply, and this server's version could not be read."
        );
      } else if (compareVersions(have, "7.4") < 0) {
        add(
          "CA_MEMORY_UNSUPPORTED",
          `The template sets a memory limit, which only Unraid 7.4 and newer apply; this server runs ${have}.`
        );
      }
    }
  }
  if (app.config.some((c) => c.type === "Device")) {
    add("CA_DEVICE_PASSTHROUGH", "The template passes host devices through to the container.");
  }
  if (app.unknownConfigTypes.length > 0) {
    add(
      "CA_UNSUPPORTED_CONFIG",
      `The template has fields UnraidClaw does not understand (${app.unknownConfigTypes.join(", ")}), so installing it would leave them out.`
    );
  }
  if (app.legacySections.length > 0) {
    add(
      "CA_LEGACY_TEMPLATE",
      `The template stores its configuration in the old ${app.legacySections.join("/")} format rather than Config entries, so its ports and volumes would be lost. Install it from the Unraid WebGUI instead.`
    );
  }

  const network = (raw.Network ?? "bridge").toLowerCase();
  if (!SUPPORTED_NETWORKS.has(network)) {
    add(
      "CA_UNSUPPORTED_NETWORK",
      `The template wants the custom network "${raw.Network}". Unraid silently falls back to no network (dropping every port) when that network is missing, so UnraidClaw will not install it. Create the container from the WebGUI instead.`
    );
  }

  if (env.unraidVersion) {
    const have = cleanVersion(env.unraidVersion);
    const min = cleanVersion(String(raw.MinVer ?? ""));
    const max = cleanVersion(String(raw.MaxVer ?? ""));
    if (have && min && compareVersions(have, min) < 0) {
      add("CA_MIN_VERSION", `The template needs Unraid ${min} or newer; this server runs ${have}.`);
    }
    if (have && max && compareVersions(have, max) > 0) {
      add("CA_MAX_VERSION", `The template supports Unraid up to ${max}; this server runs ${have}.`);
    }
  }

  if (!CA_NAME_RE.test(app.name)) {
    add(
      "CA_UNSAFE_NAME",
      `The template name ${JSON.stringify(app.name)} is not a valid Docker container name. Pass an explicit "name" to install it.`
    );
  }

  return blockers;
}

/** Required fields whose effective value is empty, so the caller must supply one. */
export function missingRequired(config: CaConfigEntry[], overrides: Map<string, string>): string[] {
  const out: string[] = [];
  for (const entry of config) {
    if (!entry.required) continue;
    const resolved = overrides.get(overrideKey(entry)) ?? entry.default;
    if (resolved.trim() === "") out.push(entry.name || entry.target);
  }
  return out;
}

function overrideKey(entry: CaConfigEntry): string {
  return `${entry.type}::${entry.target}`;
}

/**
 * Map caller-supplied overrides onto config entries.
 *
 * Keys may be either a field's display name ("Host Path for /config") or its
 * container-side target ("/config"). A key matching nothing is an error: it
 * almost certainly means the caller meant to configure something, and silently
 * ignoring it would install a differently-configured app than requested.
 */
export function resolveOverrides(
  config: CaConfigEntry[],
  overrides: Record<string, string> | undefined
): Map<string, string> {
  const resolved = new Map<string, string>();
  if (!overrides) return resolved;

  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "string") {
      throw new CaInstallError(`Override "${key}" must be a string.`, "CA_INVALID_OVERRIDE", 400);
    }
    if (hasControlChars(value)) {
      throw new CaInstallError(
        `Override "${key}" contains a control character.`,
        "CA_INVALID_OVERRIDE",
        400
      );
    }

    const byName = config.filter((c) => c.name === key);
    const byTarget = config.filter((c) => c.target === key);
    const matches = byName.length > 0 ? byName : byTarget;

    if (matches.length === 0) {
      throw new CaInstallError(
        `This template has no field called "${key}".`,
        "CA_UNKNOWN_OVERRIDE",
        400,
        { field: key, known: config.map((c) => c.name || c.target) }
      );
    }
    if (matches.length > 1) {
      throw new CaInstallError(
        `"${key}" matches ${matches.length} fields in this template; use the exact field name.`,
        "CA_AMBIGUOUS_OVERRIDE",
        400,
        { field: key }
      );
    }
    resolved.set(overrideKey(matches[0]), value);
  }
  return resolved;
}

export interface ResolvedTemplate {
  name: string;
  image: string;
  network: string;
  ports: string[];
  volumes: string[];
  env: string[];
  /** The `--memory` value as docker will see it, or "" when there is no limit. */
  memory: string;
  /** Config entries with the caller's overrides applied. */
  config: Array<CaConfigEntry & { value: string }>;
}

/**
 * Apply overrides and derive the port/volume/env lists.
 *
 * Mirrors what Unraid's xmlToCommand does with the same template, so the plan
 * we report matches what actually gets run: on a host network, ports become
 * `TCP_PORT_n` environment variables rather than published ports; on `none`
 * they are dropped entirely.
 */
export function resolveTemplate(
  app: CaApp,
  containerName: string,
  overrides: Map<string, string>
): ResolvedTemplate {
  const network = (app.raw.Network ?? "bridge").toLowerCase();
  const ports: string[] = [];
  const volumes: string[] = [];
  const env: string[] = [];
  const config: Array<CaConfigEntry & { value: string }> = [];

  // Refused here as well as in computeBlockers: nothing may reach the template
  // on flash, or the docker preview, with a limit docker would not take.
  const rawMemory = String(app.raw.Memory ?? "").trim();
  const limit = normalizeMemoryLimit(rawMemory);
  if (!limit.ok) {
    throw new CaInstallError(
      `The template's memory limit ${JSON.stringify(rawMemory)} ${memoryLimitProblem(limit.reason)}.`,
      "CA_INVALID_MEMORY",
      422
    );
  }

  for (const entry of app.config) {
    const value = overrides.get(overrideKey(entry)) ?? entry.default;
    config.push({ ...entry, value });

    if (hasControlChars(value) || hasControlChars(entry.target)) {
      throw new CaInstallError(
        `Field "${entry.name || entry.target}" contains a control character.`,
        "CA_INVALID_TEMPLATE",
        422
      );
    }
    if (value.trim() === "") continue;

    switch (entry.type) {
      case "Path":
        if (entry.target.trim() === "") break;
        volumes.push(`${value}:${entry.target}:${entry.mode}`);
        break;
      case "Port":
        if (entry.target.trim() === "") break;
        if (network === "bridge") ports.push(`${value}:${entry.target}/${entry.mode}`);
        else if (network === "host") env.push(`${entry.mode.toUpperCase()}_PORT_${entry.target}=${value}`);
        // network "none": Unraid drops port mappings entirely.
        break;
      case "Variable":
        if (entry.target.trim() === "") break;
        env.push(`${entry.target}=${value}`);
        break;
      default:
        break;
    }
  }

  return {
    name: containerName,
    image: app.repository,
    network,
    ports,
    volumes,
    env,
    memory: limit.memory,
    config,
  };
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH_MODES = new Set(["rw", "rw,slave", "rw,shared", "ro", "ro,slave", "ro,shared"]);

/**
 * Check the resolved values before anything is written.
 *
 * Unraid would happily accept most of these and produce a container that does
 * not match the template (an unusable mount, a port it never publishes), so a
 * bad value is an error rather than something to drop.
 */
export function validateResolved(resolved: ResolvedTemplate): void {
  const fail = (message: string): never => {
    throw new CaInstallError(message, "CA_INVALID_VALUE", 400);
  };

  for (const c of resolved.config) {
    // A dropdown accepts only the options the template declares. Passing
    // anything else would set the container to a value it does not understand.
    if (c.choices && !c.choices.includes(c.value)) {
      fail(
        `"${c.name || c.target}" must be one of: ${c.choices.map((o) => (o === "" ? "(empty)" : o)).join(", ")}. Got "${c.value}".`
      );
    }
    if (c.value.trim() === "") continue;
    if (c.type === "Path") {
      if (!c.value.startsWith("/")) {
        fail(`Host path for "${c.name || c.target}" must be absolute, got "${c.value}".`);
      }
      if (c.value.includes(":") || c.target.includes(":")) {
        fail(`Path for "${c.name || c.target}" must not contain a colon.`);
      }
      if (!PATH_MODES.has(c.mode)) fail(`Unsupported mount mode "${c.mode}".`);
    } else if (c.type === "Port") {
      const host = Number(c.value);
      const target = Number(c.target);
      if (!Number.isInteger(host) || host < 1 || host > 65535) {
        fail(`Host port for "${c.name || c.target}" must be 1-65535, got "${c.value}".`);
      }
      if (!Number.isInteger(target) || target < 1 || target > 65535) {
        fail(`Container port "${c.target}" must be 1-65535.`);
      }
    } else if (c.type === "Variable") {
      if (!ENV_NAME_RE.test(c.target)) {
        fail(`Environment variable name "${c.target}" is not valid.`);
      }
    }
  }
}

/** Host-side directories a Path field wants. Only absolute paths are honored. */
export function hostPaths(resolved: ResolvedTemplate): string[] {
  return resolved.config
    .filter((c) => c.type === "Path" && c.value.trim() !== "" && c.value.startsWith("/"))
    .map((c) => c.value);
}

/**
 * Serialize the Unraid docker-manager template.
 *
 * Every value is entity-encoded exactly once, matching Unraid's xml_encode /
 * xml_decode pair. ExtraParams, PostArgs and ExtraNetworks are always written
 * empty: a template that needs any of them never reaches this function.
 * Memory carries the catalog's limit through, already checked against what
 * docker accepts, because Unraid 7.4 reads it back on every later rebuild and
 * dropping it would quietly hand the app the whole machine.
 */
export function buildTemplateXml(app: CaApp, resolved: ResolvedTemplate, now = Date.now()): string {
  const raw = app.raw;
  const e = escapeXml;

  const configs = resolved.config
    // An empty host port would make Unraid emit `-p ':8096/tcp'`, which docker
    // rejects. Dropping the entry is how "do not publish this port" is said.
    .filter((c) => !(c.type === "Port" && c.value.trim() === ""))
    .map((c) => {
      const attrs = [
        `Name="${e(c.name)}"`,
        `Target="${e(c.target)}"`,
        // Default must equal the resolved value, not the catalog's default.
        // Unraid's xmlToVar falls back to Default whenever the element text is
        // empty, so leaving the original here would quietly undo an override
        // that clears a field.
        `Default="${e(c.value)}"`,
        `Mode="${e(c.mode)}"`,
        `Description="${e(c.description)}"`,
        `Type="${e(c.type)}"`,
        `Display="always"`,
        `Required="${c.required ? "true" : "false"}"`,
        `Mask="${c.mask ? "true" : "false"}"`,
      ].join(" ");
      return `  <Config ${attrs}>${e(c.value)}</Config>`;
    })
    .join("\n");

  return `<?xml version="1.0"?>
<Container version="2">
  <Name>${e(resolved.name)}</Name>
  <Repository>${e(resolved.image)}</Repository>
  <Registry>${e(raw.Registry ?? "")}</Registry>
  <Network>${e(resolved.network)}</Network>
  <ExtraNetworks/>
  <MyIP/>
  <Shell>${e(raw.Shell ?? "sh")}</Shell>
  <Privileged>false</Privileged>
  <Support>${e(raw.Support ?? "")}</Support>
  <Project>${e(raw.Project ?? "")}</Project>
  <Overview>${e(raw.Overview ?? "")}</Overview>
  <Category>${e(app.categories.join(" "))}</Category>
  <WebUI>${e(raw.WebUI ?? "")}</WebUI>
  <TemplateURL>${e(raw.TemplateURL ?? "")}</TemplateURL>
  <Icon>${e(raw.Icon ?? "")}</Icon>
  <ExtraParams/>
  <PostArgs/>
  <CPUset/>
  <Memory>${e(resolved.memory)}</Memory>
  <DateInstalled>${Math.floor(now / 1000)}</DateInstalled>
  <DonateText/>
  <DonateLink/>
  <Requires>${e(raw.Requires ?? "")}</Requires>
${configs}
</Container>`;
}

/**
 * A preview of the argv Unraid's docker manager will build from this template.
 *
 * Reported in the install plan so a person can review an install before
 * applying it. This is a reconstruction, not the command that runs: Unraid
 * builds that itself from the template we write and adds host-derived values
 * this omits (TZ and HOST_HOSTNAME from var.ini, the configured pids limit,
 * Label config entries). UnraidClaw never executes it.
 */
export function previewDockerCommand(resolved: ResolvedTemplate, app: CaApp): string[] {
  const argv = ["docker", "run", "-d", `--name=${resolved.name}`, `--net=${resolved.network}`];
  // Unraid emits `--memory=` immediately before the pids limit, and only when
  // the template sets one.
  if (resolved.memory) argv.push(`--memory=${resolved.memory}`);
  argv.push("--pids-limit", "2048");
  for (const v of resolved.env) argv.push("-e", v);
  argv.push("-e", "HOST_OS=Unraid", "-e", `HOST_CONTAINERNAME=${resolved.name}`);
  argv.push("-l", "net.unraid.docker.managed=dockerman");
  if (app.raw.WebUI) argv.push("-l", `net.unraid.docker.webui=${app.raw.WebUI}`);
  if (app.icon) argv.push("-l", `net.unraid.docker.icon=${app.icon}`);
  for (const p of resolved.ports) argv.push("-p", p);
  for (const v of resolved.volumes) argv.push("-v", v);
  argv.push(resolved.image);
  return argv;
}

export function buildPlan(
  app: CaApp,
  resolved: ResolvedTemplate,
  templatePath: string,
  templateXml: string
): CaInstallPlan {
  return {
    name: resolved.name,
    repo: app.repo,
    image: resolved.image,
    network: resolved.network,
    ports: resolved.ports,
    volumes: resolved.volumes,
    env: resolved.env,
    templatePath,
    templateXml,
    dockerCommandPreview: previewDockerCommand(resolved, app),
  };
}
