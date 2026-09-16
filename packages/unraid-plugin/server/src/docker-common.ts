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

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
