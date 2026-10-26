import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type CommandRunner = (file: string, args: string[], options: { timeout: number; maxBuffer?: number }) => Promise<{ stdout: string; stderr: string }>;
export const runCommand: CommandRunner = promisify(execFile);

export function validId(id: string): boolean {
  return id.length <= 255 && VALID_NAME_RE.test(id);
}

export function validBody(body: unknown, fields: string[]): body is Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    && Object.keys(body).every((key) => fields.includes(key));
}

export function validInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): boolean {
  return (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)))
    && Number.isSafeInteger(Number(value)) && Number(value) >= 0 && Number(value) <= max;
}

// Shared helpers for building Unraid docker-manager templates and validating
// container specs. Used by routes/docker.ts (manual container creation) and
// routes/ca.ts (Community Applications install).

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export const VALID_IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,254}$/;
export const VALID_PORT_RE = /^\d{1,5}:\d{1,5}(\/(?:tcp|udp))?$/;
export const VALID_VOLUME_RE = /^\/[^:]+:[^:]+(:(ro|rw))?$/;
export const VALID_ENV_RE = /^[a-zA-Z_][a-zA-Z0-9_]*=.*/;
export const VALID_NETWORK_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export const VALID_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export const VALID_RESTART_VALUES = new Set(["no", "always", "unless-stopped", "on-failure"]);

// Extra Parameters and Post Arguments, the two free-form fields of an Unraid
// template. UnraidClaw hands their tokens to docker through execFile, but the
// saved template is later concatenated into a /bin/sh command line unescaped
// whenever the container is edited or updated from the WebGUI, so the alphabet
// keeps out every quote, shell metacharacter, whitespace other than the single
// spaces between tokens, and control character. Anything else is refused.
export const VALID_ARG_TOKEN_RE = /^[a-zA-Z0-9:.,/+=_-]+$/;
export const MAX_ARGS_LENGTH = 2048;

/** The tokens of a free-form argument string, or null when it is not accepted. */
export function splitArgs(value: string): string[] | null {
  if (value.length === 0 || value.length > MAX_ARGS_LENGTH) return null;
  const tokens = value.split(" ");
  return tokens.every((token) => VALID_ARG_TOKEN_RE.test(token)) ? tokens : null;
}

// A cpuset as docker's --cpuset-cpus reads it: CPU numbers and ranges, comma
// separated. Unraid stores the same text in the template's CPUset field.
export const VALID_CPUSET_RE = /^\d{1,4}(-\d{1,4})?(,\d{1,4}(-\d{1,4})?)*$/;

// A device passthrough as docker's --device reads it: a host path under /dev,
// optionally a container path and the rwm permissions. Unraid stores the whole
// value in a Device config entry and passes it back to docker as --device.
export const VALID_DEVICE_RE = /^\/dev\/[a-zA-Z0-9_.+/-]+(:\/[a-zA-Z0-9_.+/-]+)?(:[rwm]{1,3})?$/;

/**
 * VALID_DEVICE_RE, and every path segment names something. Docker passes a
 * directory through as every device under it, so /dev/. or /dev// would hand
 * the container all of /dev, and .. could leave it.
 */
export function validDevice(device: string): boolean {
  if (!VALID_DEVICE_RE.test(device)) return false;
  return device
    .split(":")
    .filter((part) => part.startsWith("/"))
    .every((path) => path.slice(1).split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."));
}

/** Networks on which docker refuses a fixed container address. */
export const NETWORKS_WITHOUT_STATIC_IP = new Set(["bridge", "host", "none"]);

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
