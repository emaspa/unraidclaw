// Unraid plugin (.plg) management.
//
// Everything here is built around one fact: a .plg file is an installer script
// that Unraid's plugin manager runs as root. We cannot make that safe, and we
// do not pretend to. What we can do is make sure that nothing *we* pass to the
// plugin manager is attacker-shaped, that every mutation is deliberate and
// named, and that we never report success we have not verified.
//
// The authoritative tool is /usr/local/sbin/plugin (Lime Technology's PHP CLI).
// We call it with execFile and an argv array, never through a shell. Two of its
// behaviours shape the code below:
//
//   * `plugin install URL` builds a wget command line by string concatenation,
//     so a URL with shell metacharacters reaches a shell. We therefore never
//     hand it a URL: we fetch the .plg ourselves over validated HTTPS, write it
//     to a staging path we control, and install from that local file.
//   * `plugin update FILE` installs whatever is sitting in /tmp/plugins/FILE,
//     which `plugin check FILE` puts there by downloading the installed
//     plugin's pluginURL through that same concatenated wget. So our check
//     downloads the metadata itself, with the same validation, and stages it at
//     the path `plugin update` expects.
//
// Dry runs are pure: they resolve and describe, and touch nothing -- no
// network, no filesystem, no plugin manager.

import { execFile } from "node:child_process";
import { readFile, readdir, lstat, realpath, mkdir, writeFile, unlink, stat } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";
import type { LookupFunction } from "node:net";
import { basename, join } from "node:path";
import { parseXmlDocument, asArray, textOf, XmlParseError } from "./xml.js";

// ── Locations and limits ───────────────────────────────────────

/** Symlink per installed plugin, named after the .plg file. Its existence is the install record. */
export const PLUGIN_LINK_DIR = "/var/log/plugins";
/** Where installed .plg files live, and the only place a mutable plugin may resolve to. */
export const PLUGIN_BOOT_DIR = "/boot/config/plugins";
/** The plugin manager's staging directory: `plugin update` installs from here. */
export const PLUGIN_STAGED_DIR = "/tmp/plugins";
/** Our own download target for fresh installs. Never written by anything else. */
export const PLUGIN_STAGING_DIR = "/tmp/unraidclaw-plugins";
export const PLUGIN_CMD = "/usr/local/sbin/plugin";

/** Plugin names the OS owns. Mutating these breaks the update path for Unraid itself. */
export const BUILTIN_PLUGINS = new Set(["unRAIDServer", "unRAIDServer-"]);

/** This plugin. Its scripts stop and start the server answering the request. */
export const SELF_PLUGIN = "unraidclaw";

/** A .plg is a small XML document. Anything larger is not one. */
export const MAX_PLG_BYTES = 512 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_ATTR_LENGTH = 1024;
const MAX_CHANGES_CHARS = 4000;
const MAX_OUTPUT_CHARS = 8000;
const MAX_REDIRECTS = 3;

/** Wall clock for the whole download, redirects and body included. */
const FETCH_TIMEOUT_MS = 30_000;
const DNS_TIMEOUT_MS = 5_000;
/** Installing pulls files and runs vendor scripts; it is legitimately slow. */
export const INSTALL_TIMEOUT_MS = 15 * 60_000;
export const UPDATE_TIMEOUT_MS = 15 * 60_000;
export const REMOVE_TIMEOUT_MS = 10 * 60_000;

/**
 * A plugin file basename. Anchored, starts with an alphanumeric (so it can
 * never be read as a command-line option), and has no path separators or dots
 * that could climb out of a directory.
 */
export const PLG_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.plg$/;

// ── Wire types ─────────────────────────────────────────────────
// Mirrored in @unraidclaw/shared once the shared api-types land; kept here so
// this module and its tests stand alone.

export interface PluginSummary {
  file: string;
  name: string;
  author: string;
  version: string;
  pluginURL: string;
  path: string;
  builtin: boolean;
  stagedVersion?: string;
  updateAvailable?: boolean;
}

export interface PluginListResponse {
  plugins: PluginSummary[];
  total: number;
  skipped: Array<{ file: string; reason: string }>;
}

export interface PluginFileEntry {
  name: string;
  method: string;
  source: "URL" | "LOCAL" | "INLINE" | "none";
  run: string;
  url: string;
}

export interface PluginDetail extends PluginSummary {
  min: string;
  max: string;
  support: string;
  icon: string;
  launch: string;
  noInstall: boolean;
  files: PluginFileEntry[];
  changes: string;
}

export interface PluginInstallRequest {
  url: string;
  dryRun?: boolean;
}

export interface PluginActionRequest {
  dryRun?: boolean;
}

export interface PluginPlan {
  action: "install" | "check" | "update" | "remove";
  file: string;
  steps: string[];
  warnings: string[];
}

export interface PluginInstallResponse {
  dryRun: boolean;
  plan: PluginPlan;
  url: string;
  installed?: PluginSummary;
  registered?: boolean;
  output?: string;
}

export interface PluginCheckResponse {
  dryRun: boolean;
  plan: PluginPlan;
  file: string;
  installedVersion: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  output?: string;
}

export interface PluginUpdateResponse {
  dryRun: boolean;
  plan: PluginPlan;
  file: string;
  previousVersion: string;
  installedVersion?: string;
  verified?: boolean;
  output?: string;
}

export interface PluginRemoveResponse {
  dryRun: boolean;
  plan: PluginPlan;
  file: string;
  removed?: boolean;
  output?: string;
}

// ── Errors ─────────────────────────────────────────────────────

export class PluginError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 400,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "PluginError";
  }
}

// ── Runtime: everything with a side effect ─────────────────────

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export interface PluginsRuntime {
  linkDir: string;
  bootDir: string;
  stagedDir: string;
  stagingDir: string;
  pluginCmd: string;
  /** Runs a program with an argv array. Never a shell. Always bounded. Never throws on a non-zero exit. */
  run(file: string, args: string[], timeoutMs: number): Promise<RunResult>;
  /** Symlink target, or null when the link is missing, dangling, or not a symlink. */
  readLink(path: string): Promise<string | null>;
  /** Names of the .plg entries in the link directory. */
  listLinks(): Promise<string[]>;
  /** File contents, or null when absent. Refuses anything over MAX_PLG_BYTES. */
  readPlg(path: string): Promise<string | null>;
  pathExists(path: string): Promise<boolean>;
  /** Fetches a .plg over HTTPS with full URL validation on every hop. */
  fetchPlg(url: string): Promise<{ text: string; finalUrl: string }>;
  /** Every address a hostname resolves to, for the private-range check. */
  resolveHost(host: string): Promise<string[]>;
  /** Writes a staging file, replacing any previous one. */
  writeStaged(path: string, content: string): Promise<void>;
  removeStaged(path: string): Promise<void>;
}

export type PluginsRuntimeOptions = Partial<PluginsRuntime>;

export function createPluginsRuntime(overrides: PluginsRuntimeOptions = {}): PluginsRuntime {
  const runtime: PluginsRuntime = {
    linkDir: overrides.linkDir ?? PLUGIN_LINK_DIR,
    bootDir: overrides.bootDir ?? PLUGIN_BOOT_DIR,
    stagedDir: overrides.stagedDir ?? PLUGIN_STAGED_DIR,
    stagingDir: overrides.stagingDir ?? PLUGIN_STAGING_DIR,
    pluginCmd: overrides.pluginCmd ?? PLUGIN_CMD,

    run:
      overrides.run ??
      ((file, args, timeoutMs) =>
        new Promise<RunResult>((resolve) => {
          execFile(
            file,
            args,
            { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
            (err, stdout, stderr) => {
              const killed = Boolean(err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed);
              const raw = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0;
              resolve({
                stdout: String(stdout ?? ""),
                stderr: String(stderr ?? ""),
                code: typeof raw === "number" ? raw : err ? 1 : 0,
                timedOut: killed,
              });
            }
          );
        })),

    readLink:
      overrides.readLink ??
      (async (path) => {
        try {
          // The registration must be a symlink, as the plugin manager writes
          // it. realpath then follows a relative or chained link all the way
          // down, so what comes back is the file that would actually be read
          // and the path the protected-location check can trust.
          if (!(await lstat(path)).isSymbolicLink()) return null;
          const target = await realpath(path);
          // A dangling link is not an installed plugin; the plugin manager
          // treats it the same way and cleans it up on its next run.
          if (!(await stat(target)).isFile()) return null;
          return target;
        } catch {
          return null;
        }
      }),

    listLinks:
      overrides.listLinks ??
      (async () => {
        try {
          return (await readdir(runtime.linkDir)).filter((f) => f.endsWith(".plg"));
        } catch {
          return [];
        }
      }),

    readPlg:
      overrides.readPlg ??
      (async (path) => {
        try {
          const info = await stat(path);
          if (!info.isFile()) return null;
          if (info.size > MAX_PLG_BYTES) {
            throw new PluginError(
              `Plugin file ${path} is ${info.size} bytes; the limit is ${MAX_PLG_BYTES}.`,
              "PLUGIN_TOO_LARGE",
              422
            );
          }
          return await readFile(path, "utf8");
        } catch (err) {
          if (err instanceof PluginError) throw err;
          return null;
        }
      }),

    pathExists:
      overrides.pathExists ??
      (async (path) => {
        try {
          await stat(path);
          return true;
        } catch {
          return false;
        }
      }),

    resolveHost:
      overrides.resolveHost ??
      (async (host) => {
        const records = await lookup(host, { all: true, verbatim: true });
        return records.map((r) => r.address);
      }),

    fetchPlg: overrides.fetchPlg ?? ((url) => downloadPlg(url, runtime)),

    writeStaged:
      overrides.writeStaged ??
      (async (path, content) => {
        await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
        await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
      }),

    removeStaged:
      overrides.removeStaged ??
      (async (path) => {
        await unlink(path).catch(() => undefined);
      }),
  };

  return runtime;
}

// ── Name and URL validation ────────────────────────────────────

/**
 * Normalises a caller-supplied plugin identifier to a .plg basename.
 *
 * This value ends up as an argv element for the plugin manager and as a path
 * segment under /var/log/plugins, /boot/config/plugins and /tmp/plugins, so it
 * is checked hard: no separators, no traversal, no leading dash.
 */
export function normalizePluginFile(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new PluginError("The plugin name must be a string.", "PLUGIN_INVALID_NAME", 400);
  }
  const trimmed = raw.trim();
  const file = trimmed.toLowerCase().endsWith(".plg") ? trimmed : `${trimmed}.plg`;
  if (!PLG_FILE_RE.test(file) || file !== basename(file) || file.includes("..")) {
    throw new PluginError(
      `Plugin name ${JSON.stringify(raw)} is not a plugin file name. Use the .plg basename, e.g. "unassigned.devices.plg": 1-64 characters of letters, digits, dot, dash or underscore, starting with a letter or digit.`,
      "PLUGIN_INVALID_NAME",
      400,
      { name: raw }
    );
  }
  return file;
}

export interface ValidatedPluginUrl {
  /** The URL as normalised by WHATWG parsing. */
  url: string;
  /** The .plg basename the URL points at. */
  file: string;
  host: string;
}

/**
 * The syntax half of URL validation: everything that can be decided without
 * touching the network, so a dry run can run it.
 *
 * Installing a plugin from a URL is, by definition, trusting whoever controls
 * that URL to run code as root. These rules do not change that. What they do is
 * keep the URL from being a vehicle for something *other* than the install the
 * caller asked for: no non-HTTPS transport, no credentials that would be logged
 * or forwarded, no fragment or query smuggling a different filename, and no
 * filename that could be read as a path or an option.
 */
export function validatePluginUrlSyntax(raw: unknown, field = "url"): ValidatedPluginUrl {
  const fail = (message: string, code = "PLUGIN_INVALID_URL"): never => {
    throw new PluginError(message, code, 400, { field });
  };

  if (typeof raw !== "string" || raw.trim() === "") {
    fail(`"${field}" must be an https URL ending in .plg.`);
  }
  const text = (raw as string).trim();
  if (text.length > MAX_URL_LENGTH) fail(`"${field}" is longer than ${MAX_URL_LENGTH} characters.`);
  if (/[\x00-\x20\x7f]/.test(text)) fail(`"${field}" contains control or whitespace characters.`);

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail(`"${field}" is not a valid URL.`);
  }

  if (url.protocol !== "https:") {
    fail(`"${field}" must use https. Plugin files are executed as root; plain http is refused.`);
  }
  if (url.username || url.password) {
    fail(`"${field}" must not contain credentials.`);
  }
  if (url.hash) fail(`"${field}" must not contain a fragment.`);
  if (url.port && url.port !== "443") {
    fail(`"${field}" must use the default https port.`);
  }

  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return fail(`"${field}" has an undecodable path.`);
  }
  if (!path.endsWith(".plg")) {
    fail(`"${field}" must point at a .plg file.`);
  }
  // A path that only looks like a plain file path once it is decoded is not
  // one: percent-encoded traversal and backslashes are how a URL is written to
  // read one way here and another way to whatever serves or logs it.
  if (path.split("/").some((segment) => segment === "." || segment === "..") || /[\\\x00-\x1f\x7f]/.test(path)) {
    fail(`"${field}" has a path that is not a plain file path.`);
  }
  const file = basename(path);
  if (!PLG_FILE_RE.test(file)) {
    fail(
      `The file name in "${field}" (${JSON.stringify(file)}) is not a usable plugin file name: 1-64 characters of letters, digits, dot, dash or underscore, starting with a letter or digit, ending in .plg.`
    );
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".localdomain")) {
    fail(`"${field}" points at the local machine. Plugins must come from a public https host.`, "PLUGIN_URL_NOT_PUBLIC");
  }
  const literal = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIpLiteral(literal) && !isPublicAddress(literal)) {
    fail(
      `"${field}" points at a private or reserved address (${literal}). Plugins must come from a public https host.`,
      "PLUGIN_URL_NOT_PUBLIC"
    );
  }

  return { url: url.toString(), file, host: literal };
}

function isIpLiteral(host: string): boolean {
  return /^[0-9.]+$/.test(host) || host.includes(":");
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | Array<{ address: string; family: number }>,
  family?: number
) => void;

/**
 * The name resolution the TLS connection itself uses.
 *
 * Checking a hostname and then letting fetch resolve it again is not a check:
 * the second answer can be a different address, which is all DNS rebinding is.
 * This runs as the socket's own `lookup`, so the address it approves is the
 * address the connection uses, and there is no second query to poison. A name
 * with any private or reserved address among its answers is refused outright
 * rather than filtered down to the public ones.
 */
export function publicOnlyLookup(resolve: (host: string) => Promise<string[]>) {
  return function lookupPublicOnly(hostname: string, options: unknown, callback: LookupCallback): void {
    let settled = false;
    const finish = (err: Error | null, address?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err || !address) {
        callback((err ?? new Error("lookup failed")) as NodeJS.ErrnoException);
        return;
      }
      const family = address.includes(":") ? 6 : 4;
      const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
      if (all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };

    const timer = setTimeout(
      () => finish(new PluginError(`Timed out resolving ${hostname}.`, "PLUGIN_URL_UNRESOLVABLE", 502)),
      DNS_TIMEOUT_MS
    );

    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          finish(new PluginError(`Could not resolve ${hostname}.`, "PLUGIN_URL_UNRESOLVABLE", 502));
          return;
        }
        const bad = addresses.find((a) => !isPublicAddress(a));
        if (bad) {
          finish(
            new PluginError(
              `${hostname} resolves to a private or reserved address (${bad}). Plugins must come from a public https host.`,
              "PLUGIN_URL_NOT_PUBLIC",
              400
            )
          );
          return;
        }
        finish(null, addresses[0]);
      },
      () => finish(new PluginError(`Could not resolve ${hostname}.`, "PLUGIN_URL_UNRESOLVABLE", 502))
    );
  };
}

/** Where a redirect goes, held to every rule the original URL had to pass. */
export function nextHop(location: string, currentUrl: string): ValidatedPluginUrl {
  let resolved: string;
  try {
    resolved = new URL(location, currentUrl).toString();
  } catch {
    throw new PluginError("The server sent a redirect to an unreadable location.", "PLUGIN_DOWNLOAD_FAILED", 502);
  }
  return validatePluginUrlSyntax(resolved, "redirect location");
}

/**
 * Reads a response body, counting as it goes and destroying the stream the
 * moment it passes the limit or the deadline. Buffering first and measuring
 * afterwards is not a limit: a chunked response never has to declare its
 * length. A deadline is just as necessary as the byte cap, because a server
 * that dribbles one byte at a time stays under every size limit and under the
 * socket's idle timeout while holding the plugin lock for as long as it likes.
 */
export async function readBounded(stream: Readable, limit: number, deadlineMs: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  return await new Promise<Buffer>((resolve, reject) => {
    const stop = (err: PluginError) => {
      clearTimeout(timer);
      stream.destroy();
      reject(err);
    };
    const timer = setTimeout(
      () => stop(new PluginError("The download timed out.", "PLUGIN_DOWNLOAD_TIMEOUT", 504)),
      Math.max(deadlineMs, 1)
    );
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        stop(new PluginError(`The plugin file is larger than ${limit} bytes.`, "PLUGIN_TOO_LARGE", 422));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    stream.on("error", (err) => {
      clearTimeout(timer);
      reject(
        err instanceof PluginError
          ? err
          : new PluginError(`The download failed: ${err.message}`, "PLUGIN_DOWNLOAD_FAILED", 502)
      );
    });
  });
}

interface Hop {
  status: number;
  location: string | null;
  stream: Readable;
  discard(): void;
}

function requestOnce(target: ValidatedPluginUrl, rt: PluginsRuntime, budgetMs: number): Promise<Hop> {
  const url = new URL(target.url);
  const timedOut = () => new PluginError("The download timed out.", "PLUGIN_DOWNLOAD_TIMEOUT", 504);
  return new Promise<Hop>((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: "https:",
        // target.host is the hostname with any IPv6 brackets removed; url.hostname
        // keeps them, and the socket layer wants the bare address.
        hostname: target.host,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { accept: "application/xml, text/xml, */*" },
        // SNI carries a name, never an address.
        ...(isIpLiteral(target.host) ? {} : { servername: target.host }),
        timeout: Math.max(budgetMs, 1),
        lookup: publicOnlyLookup(rt.resolveHost) as unknown as LookupFunction,
      },
      (res) => {
        // The headers deadline ends here. The body is bounded by readBounded,
        // which gets what is left of the same budget, and a discarded redirect
        // body never gets read at all.
        clearTimeout(headersDeadline);
        resolve({
          status: res.statusCode ?? 0,
          location: res.headers.location ?? null,
          stream: res,
          discard: () => res.destroy(),
        });
      }
    );
    const headersDeadline = setTimeout(() => req.destroy(timedOut()), Math.max(budgetMs, 1));
    req.on("timeout", () => req.destroy(timedOut()));
    req.on("error", (err) => {
      clearTimeout(headersDeadline);
      reject(
        err instanceof PluginError
          ? err
          : new PluginError(`Could not download the plugin file: ${err.message}`, "PLUGIN_DOWNLOAD_FAILED", 502)
      );
    });
    req.end();
  });
}

/**
 * IPv6 as eight 16-bit groups, or null when the text is not an address.
 *
 * The expansion matters: `::ffff:127.0.0.1`, `::ffff:7f00:1` and
 * `0:0:0:0:0:ffff:7f00:0001` are the same address, and WHATWG URL parsing
 * rewrites the first into the second, so a check that only recognises the
 * dotted spelling passes loopback straight through.
 */
export function expandIpv6(address: string): number[] | null {
  if (!address.includes(":")) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;

  const groupsOf = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (const [index, piece] of pieces.entries()) {
      if (/^[0-9a-f]{1,4}$/.test(piece)) {
        out.push(parseInt(piece, 16));
        continue;
      }
      // A dotted tail is only legal as the last piece.
      const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(piece);
      if (!dotted || index !== pieces.length - 1) return null;
      const octets = dotted.slice(1).map(Number);
      if (octets.some((o) => o > 255)) return null;
      out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    }
    return out;
  };

  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (head === null || tail === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const gap = 8 - head.length - tail.length;
  if (gap < 1) return null;
  return [...head, ...Array<number>(gap).fill(0), ...tail];
}

function dotted(high: number, low: number): string {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isPublicAddress(address: string): boolean {
  const addr = address.toLowerCase().split("%")[0].replace(/^\[|\]$/g, "");

  if (addr.includes(":")) {
    const groups = expandIpv6(addr);
    if (groups === null) return false;
    // ::ffff:0:0/96, in any spelling: the embedded v4 address is the real one.
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
      return isPublicAddress(dotted(groups[6], groups[7]));
    }
    // ::/96 covers the unspecified address, loopback and the deprecated
    // v4-compatible form. None of it routes anywhere public.
    if (groups.slice(0, 6).every((g) => g === 0)) return false;
    // NAT64 and 6to4 both wrap a v4 address; judge the address they carry.
    if (groups[0] === 0x64 && groups[1] === 0xff9b) return isPublicAddress(dotted(groups[6], groups[7]));
    if (groups[0] === 0x2002) return isPublicAddress(dotted(groups[1], groups[2]));
    if ((groups[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((groups[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
    if ((groups[0] & 0xff00) === 0xff00) return false; // ff00::/8 multicast
    return true;
  }

  const parts = addr.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false; // link local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false; // 192.0.0.0/24 and 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a >= 224) return false; // multicast and reserved
  return true;
}

async function downloadPlg(rawUrl: string, rt: PluginsRuntime): Promise<{ text: string; finalUrl: string }> {
  let current = validatePluginUrlSyntax(rawUrl);
  // One budget for the whole download. Per-hop timeouts would let a chain of
  // slow redirects, or a slow body after fast headers, run for as long as the
  // other end cares to drag it out, with the plugin lock held throughout.
  const expiresAt = Date.now() + FETCH_TIMEOUT_MS;
  const remaining = () => {
    const left = expiresAt - Date.now();
    if (left <= 0) throw new PluginError("The download timed out.", "PLUGIN_DOWNLOAD_TIMEOUT", 504);
    return left;
  };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await requestOnce(current, rt, remaining());

    if (res.status >= 300 && res.status < 400) {
      // The redirect body is of no interest and is not going to be counted, so
      // it is dropped rather than read.
      res.discard();
      if (!res.location) {
        throw new PluginError("The server sent a redirect without a location.", "PLUGIN_DOWNLOAD_FAILED", 502);
      }
      current = nextHop(res.location, current.url);
      continue;
    }

    if (res.status !== 200) {
      res.discard();
      throw new PluginError(
        `The plugin file could not be downloaded (HTTP ${res.status}).`,
        "PLUGIN_DOWNLOAD_FAILED",
        502
      );
    }

    const body = await readBounded(res.stream, MAX_PLG_BYTES, remaining());
    return { text: body.toString("utf8"), finalUrl: current.url };
  }
  throw new PluginError("Too many redirects while downloading the plugin file.", "PLUGIN_DOWNLOAD_FAILED", 502);
}

// ── .plg parsing ───────────────────────────────────────────────

export interface ParsedPlg {
  attrs: Record<string, string>;
  files: PluginFileEntry[];
  changes: string;
}

/**
 * Reads a .plg as data. Structure and attributes only: FILE elements are
 * summarised, and an INLINE script body is never read out of the document, so
 * inspecting a plugin cannot leak a key someone embedded in one and cannot be
 * confused with running it.
 */
export function parsePlg(xml: string, source: string): ParsedPlg {
  if (xml.length > MAX_PLG_BYTES) {
    throw new PluginError(`${source} is larger than ${MAX_PLG_BYTES} bytes.`, "PLUGIN_TOO_LARGE", 422);
  }
  let doc: Record<string, unknown>;
  try {
    // Real plugin files declare their name, version and pluginURL as internal
    // entities and reference them from the PLUGIN attributes, so the values we
    // read are the expanded ones. Anything beyond quoted literal general
    // entities is refused by the parser.
    doc = parseXmlDocument(xml, {
      allowInternalEntities: true,
      alwaysArray: ["FILE"],
      maxBytes: MAX_PLG_BYTES,
    });
  } catch (err) {
    const code = err instanceof XmlParseError ? err.code : "XML_INVALID";
    throw new PluginError(
      `${source} is not a readable plugin file (${code}).`,
      "PLUGIN_INVALID_XML",
      422
    );
  }

  const root = doc.PLUGIN as Record<string, unknown> | undefined;
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new PluginError(`${source} has no <PLUGIN> element.`, "PLUGIN_INVALID_XML", 422);
  }

  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(root)) {
    if (!key.startsWith("@_")) continue;
    attrs[key.slice(2)] = clamp(String(value ?? ""), MAX_ATTR_LENGTH);
  }

  const files: PluginFileEntry[] = asArray(root.FILE as unknown).map((entry) => {
    const node = (entry ?? {}) as Record<string, unknown>;
    const source_: PluginFileEntry["source"] =
      node.URL !== undefined ? "URL" : node.LOCAL !== undefined ? "LOCAL" : node.INLINE !== undefined ? "INLINE" : "none";
    return {
      name: clamp(String(node["@_Name"] ?? ""), MAX_ATTR_LENGTH),
      method: clamp(String(node["@_Method"] ?? "install"), MAX_ATTR_LENGTH),
      source: source_,
      run: clamp(String(node["@_Run"] ?? ""), MAX_ATTR_LENGTH),
      // Deliberately only for URL entries: INLINE bodies are never echoed.
      url: source_ === "URL" ? clamp(textOf(node.URL), MAX_URL_LENGTH) : "",
    };
  });

  return { attrs, files, changes: clamp(textOf(root.CHANGES), MAX_CHANGES_CHARS) };
}

/** Attribute lookup that ignores case, the way real .plg files are written. */
export function attr(parsed: ParsedPlg, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(parsed.attrs)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return "";
}

/**
 * The plugin manager's own test is `!plugin('noInstall', ...)`, and PHP counts
 * only "" and "0" as false. So `noInstall="false"` means the plugin manager
 * will treat the file as a one-shot script, and so do we: matching its verdict
 * matters more than reading the word.
 */
export function isNoInstall(parsed: ParsedPlg): boolean {
  const value = attr(parsed, "noInstall").trim();
  return value !== "" && value !== "0";
}

function clamp(value: string, max: number): string {
  const clean = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Plugin manager output, bounded and stripped of control characters, for a response body. */
export function sanitizeOutput(...parts: string[]): string {
  const joined = parts.filter(Boolean).join("\n").replace(/\r/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  const collapsed = joined.replace(/\n{3,}/g, "\n\n").trim();
  return collapsed.length > MAX_OUTPUT_CHARS
    ? `${collapsed.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated`
    : collapsed;
}

/** Upstream compares versions with strcmp, and so do we, for the same verdicts. */
export function isNewer(candidate: string, installed: string): boolean {
  if (!candidate || !installed) return false;
  return candidate > installed;
}

// ── Installed-plugin lookups ───────────────────────────────────

export function summarize(file: string, path: string, parsed: ParsedPlg, bootDir: string): PluginSummary {
  return {
    file,
    name: attr(parsed, "name") || file.replace(/\.plg$/, ""),
    author: attr(parsed, "author") || "anonymous",
    version: attr(parsed, "version"),
    pluginURL: attr(parsed, "pluginURL"),
    path,
    builtin: isProtected(file, path, bootDir),
  };
}

/**
 * Plugins we refuse to install over, update or remove: the OS's own, and
 * anything whose installed file lives outside /boot/config/plugins, which means
 * it is shipped with the OS image rather than owned by the user.
 */
export function isProtected(file: string, path: string, bootDir: string): boolean {
  if (isBuiltinName(file)) return true;
  return path !== join(bootDir, file);
}

/**
 * Matched without regard to case and with or without the .plg suffix, against
 * both a file name and a plugin's own name attribute. A fresh install has no
 * registration to consult, so the name is all there is to go on.
 */
export function isBuiltinName(value: string): boolean {
  const candidate = value.trim().replace(/\.plg$/i, "").toLowerCase();
  for (const builtin of BUILTIN_PLUGINS) {
    if (builtin.toLowerCase() === candidate) return true;
  }
  return false;
}

export function detail(summary: PluginSummary, parsed: ParsedPlg): PluginDetail {
  return {
    ...summary,
    min: attr(parsed, "min"),
    max: attr(parsed, "max") || attr(parsed, "Unraid"),
    support: attr(parsed, "support"),
    icon: attr(parsed, "icon"),
    launch: attr(parsed, "launch"),
    noInstall: isNoInstall(parsed),
    files: parsed.files,
    changes: parsed.changes,
  };
}

/**
 * The checks every plugin document has to pass before it is allowed anywhere
 * near the plugin manager: on download, on staging, and again on the staged
 * file at the moment an update is applied. A file dropped into /tmp/plugins by
 * something else is not evidence of anything, so the staged document is
 * re-read and re-checked rather than trusted because a check once wrote there.
 */
export function assertInstallable(
  parsed: ParsedPlg,
  file: string,
  expectedName: string | null,
  source: string
): { name: string; version: string } {
  const name = attr(parsed, "name");
  const version = attr(parsed, "version");
  if (!name || !version) {
    throw new PluginError(
      `${source} has no name or version attribute, so it cannot be installed or tracked.`,
      "PLUGIN_INVALID_METADATA",
      422,
      { file, name, version }
    );
  }
  if (isBuiltinName(name) || isBuiltinName(file)) {
    throw new PluginError(
      `"${name}" is an Unraid OS plugin. UnraidClaw does not install, update or remove OS plugins; use the Unraid web UI.`,
      "PLUGIN_PROTECTED",
      422,
      { file, name }
    );
  }
  if (isNoInstall(parsed)) {
    throw new PluginError(
      `${source} sets noInstall, which makes the plugin manager execute it once and never register it. UnraidClaw cannot verify, update or remove that, so it refuses to run it. Use the Unraid web UI if that is what you want.`,
      "PLUGIN_NOINSTALL_UNSUPPORTED",
      422,
      { file, name }
    );
  }
  if (expectedName !== null && name !== expectedName) {
    throw new PluginError(
      `${source} is "${name}", not "${expectedName}".`,
      "PLUGIN_IDENTITY_MISMATCH",
      422,
      { file, expected: expectedName, found: name }
    );
  }
  return { name, version };
}

export function isSelfPlugin(value: string): boolean {
  return value.trim().replace(/\.plg$/i, "").toLowerCase() === SELF_PLUGIN;
}

/**
 * UnraidClaw will not install over, update or remove itself here.
 *
 * Not a policy about self-modification: a mechanical limit. This plugin's
 * install and removal scripts stop and restart the server process handling the
 * request, so the call is cut off before it can read back what happened. A
 * result we cannot verify is worse than a refusal, and a hung request that
 * reports nothing is worse than both. Listing, inspecting and checking for
 * updates stay available, because none of them runs a plugin script.
 */
export function assertNotSelf(file: string, name: string | null, action: "install" | "update" | "remove"): void {
  if (!isSelfPlugin(file) && !(name !== null && isSelfPlugin(name))) return;
  throw new PluginError(
    `UnraidClaw cannot ${action} itself through this API: this plugin's scripts stop and restart the very server answering the request, so the call would be cut off before the result could be verified or returned. Use the Plugins page in the Unraid web UI, or run the plugin manager over SSH.`,
    "PLUGIN_SELF_MANAGEMENT_UNSUPPORTED",
    422,
    { file, action }
  );
}

export interface InstalledPlugin {
  summary: PluginSummary;
  parsed: ParsedPlg;
}

/** Resolves an installed plugin, or throws the 404 the caller should send. */
export async function loadInstalled(rt: PluginsRuntime, file: string): Promise<InstalledPlugin> {
  const target = await rt.readLink(join(rt.linkDir, file));
  if (!target) {
    throw new PluginError(`Plugin "${file}" is not installed.`, "PLUGIN_NOT_FOUND", 404, { file });
  }
  const xml = await rt.readPlg(target);
  if (xml === null) {
    throw new PluginError(
      `Plugin "${file}" is registered but its file (${target}) could not be read.`,
      "PLUGIN_FILE_UNREADABLE",
      422,
      { file, path: target }
    );
  }
  const parsed = parsePlg(xml, `Plugin file ${target}`);
  return { summary: summarize(file, target, parsed, rt.bootDir), parsed };
}

export async function listInstalled(rt: PluginsRuntime): Promise<PluginListResponse> {
  const plugins: PluginSummary[] = [];
  const skipped: Array<{ file: string; reason: string }> = [];

  for (const file of (await rt.listLinks()).sort()) {
    if (!PLG_FILE_RE.test(file)) {
      skipped.push({ file, reason: "not a usable plugin file name" });
      continue;
    }
    const target = await rt.readLink(join(rt.linkDir, file));
    if (!target) {
      skipped.push({ file, reason: "registration points at a missing file" });
      continue;
    }
    let summary: PluginSummary;
    try {
      const xml = await rt.readPlg(target);
      if (xml === null) {
        skipped.push({ file, reason: `plugin file ${target} could not be read` });
        continue;
      }
      summary = summarize(file, target, parsePlg(xml, `Plugin file ${target}`), rt.bootDir);
    } catch (err) {
      skipped.push({ file, reason: err instanceof PluginError ? err.message : "plugin file could not be parsed" });
      continue;
    }

    // A staged file in the plugin manager's own directory is an update armed
    // by an earlier check -- ours, the web UI's, or the nightly one.
    const stagedPath = join(rt.stagedDir, file);
    if (await rt.pathExists(stagedPath)) {
      try {
        const stagedXml = await rt.readPlg(stagedPath);
        if (stagedXml !== null) {
          const stagedVersion = attr(parsePlg(stagedXml, `Staged plugin file ${stagedPath}`), "version");
          if (stagedVersion) {
            summary.stagedVersion = stagedVersion;
            summary.updateAvailable = isNewer(stagedVersion, summary.version);
          }
        }
      } catch {
        // A junk staged file is the plugin manager's problem, not a reason to
        // hide an installed plugin from the list.
      }
    }
    plugins.push(summary);
  }

  return { plugins, total: plugins.length, skipped };
}

export function assertMutable(summary: PluginSummary): void {
  if (summary.builtin) {
    throw new PluginError(
      `"${summary.file}" is part of Unraid itself (installed at ${summary.path}). UnraidClaw does not install over, update or remove OS plugins; use the Unraid web UI.`,
      "PLUGIN_PROTECTED",
      422,
      { file: summary.file, path: summary.path }
    );
  }
}

// ── Operation lock ─────────────────────────────────────────────

const inFlight = new Map<string, string>();

/**
 * One mutation per plugin at a time. The plugin manager shares /tmp/plugins and
 * /boot/config/plugins between operations, so two overlapping calls can install
 * a file the other one is replacing.
 */
export async function withPluginLock<T>(file: string, action: string, fn: () => Promise<T>): Promise<T> {
  const current = inFlight.get(file);
  if (current) {
    throw new PluginError(
      `Another ${current} operation is already running for "${file}".`,
      "PLUGIN_BUSY",
      409,
      { file, running: current }
    );
  }
  inFlight.set(file, action);
  try {
    return await fn();
  } finally {
    inFlight.delete(file);
  }
}

/** Test seam: forget any lock left behind by a failed test. */
export function clearPluginLocks(): void {
  inFlight.clear();
}

// ── Plans ──────────────────────────────────────────────────────

export function installPlan(file: string, url: string, stagingPath: string, bootDir: string): PluginPlan {
  return {
    action: "install",
    file,
    steps: [
      `Download ${url} over https (redirects re-validated, private addresses refused)`,
      `Validate it as a plugin file and write it to ${stagingPath}`,
      `Run: plugin install ${stagingPath}`,
      `Verify the plugin registered itself in /var/log/plugins/${file} and copied to ${join(bootDir, file)}`,
      `Delete ${stagingPath}`,
    ],
    warnings: [
      "A plugin file is an installer that Unraid runs as root: it downloads and executes code from whoever controls this URL. Install only plugins you trust.",
      "The plugin's own scripts decide what they write to the flash drive and to your array.",
    ],
  };
}

export function checkPlan(file: string, pluginURL: string, stagedPath: string): PluginPlan {
  return {
    action: "check",
    file,
    steps: [
      `Download the plugin's pluginURL (${pluginURL}) over https`,
      `Write it to ${stagedPath}, where Unraid's plugin manager looks for a pending update`,
      "Report the installed version and the downloaded one",
    ],
    warnings: [
      "This is not a read-only operation: it downloads a file from the internet and stages an update that the Unraid web UI and `plugin update` will then offer to install. Nothing is installed or executed by the check itself.",
    ],
  };
}

export function updatePlan(file: string, stagedPath: string, from: string, to: string): PluginPlan {
  return {
    action: "update",
    file,
    steps: [
      `Install the staged plugin file at ${stagedPath} (version ${to || "unknown"}) over the installed version ${from || "unknown"}`,
      `Run: plugin update ${file}`,
      "Verify the registered plugin file now reports the staged version",
    ],
    warnings: [
      "Updating runs the new plugin's install scripts as root, and the plugin manager's pre/post hook scripts along with them.",
      "There is no rollback. If the update fails partway, the plugin can be left unregistered.",
    ],
  };
}

export function removePlan(file: string, bootDir: string): PluginPlan {
  return {
    action: "remove",
    file,
    steps: [
      `Run: plugin remove ${file}`,
      `Verify /var/log/plugins/${file} is gone and the plugin file has left ${bootDir}`,
    ],
    warnings: [
      "Removal runs the plugin's own removal scripts as root. What they delete is up to the plugin: some leave their configuration and data in place, others delete it. UnraidClaw cannot promise your data survives.",
      "Any container, share or setting that depends on this plugin stops working.",
    ],
  };
}
