import { readFileSync, watchFile, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PermissionMatrix, createDefaultMatrix } from "@unraidclaw/shared";

export interface ServerConfig {
  port: number;
  host: string;
  apiKeyHash: string;
  graphqlUrl: string;
  unraidApiKey: string;
  logFile: string;
  maxLogSize: number;
  tlsCert: string;
  tlsKey: string;
}

const FLASH_BASE = process.env.FLASH_BASE ?? "/boot/config/plugins/unraidclaw";
const CFG_FILE = join(FLASH_BASE, "unraidclaw.cfg");
const PERMISSIONS_FILE = join(FLASH_BASE, "permissions.json");

function ensureFlashDir(): void {
  if (!existsSync(FLASH_BASE)) {
    mkdirSync(FLASH_BASE, { recursive: true });
  }
}

function parseCfg(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export function loadConfig(): ServerConfig {
  ensureFlashDir();
  let cfg: Record<string, string> = {};
  if (existsSync(CFG_FILE)) {
    cfg = parseCfg(readFileSync(CFG_FILE, "utf-8"));
  }

  const tlsDir = join(FLASH_BASE, "tls");
  return {
    port: parseInt(cfg.PORT ?? process.env.OCC_PORT ?? "9876", 10),
    host: cfg.HOST ?? process.env.OCC_HOST ?? "0.0.0.0",
    apiKeyHash: cfg.API_KEY_HASH ?? process.env.OCC_API_KEY_HASH ?? "",
    graphqlUrl: cfg.GRAPHQL_URL ?? process.env.OCC_GRAPHQL_URL ?? "http://localhost/graphql",
    unraidApiKey: cfg.UNRAID_API_KEY ?? process.env.OCC_UNRAID_API_KEY ?? "",
    logFile: cfg.LOG_FILE ?? process.env.OCC_LOG_FILE ?? join(FLASH_BASE, "activity.jsonl"),
    maxLogSize: parseInt(cfg.MAX_LOG_SIZE ?? process.env.OCC_MAX_LOG_SIZE ?? "10485760", 10),
    tlsCert: cfg.TLS_CERT ?? process.env.OCC_TLS_CERT ?? join(tlsDir, "cert.pem"),
    tlsKey: cfg.TLS_KEY ?? process.env.OCC_TLS_KEY ?? join(tlsDir, "key.pem"),
  };
}

let currentPermissions: PermissionMatrix = createDefaultMatrix(false);

export function loadPermissions(): PermissionMatrix {
  if (existsSync(PERMISSIONS_FILE)) {
    try {
      const raw = readFileSync(PERMISSIONS_FILE, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PermissionMatrix>;
      const matrix = createDefaultMatrix(false);
      for (const [key, value] of Object.entries(parsed)) {
        if (key in matrix) {
          (matrix as Record<string, boolean>)[key] = value === true;
        }
      }
      currentPermissions = matrix;
    } catch {
      currentPermissions = createDefaultMatrix(false);
    }
  } else {
    ensureFlashDir();
    const defaultMatrix = createDefaultMatrix(false);
    writeFileSync(PERMISSIONS_FILE, JSON.stringify(defaultMatrix, null, 2), "utf-8");
    currentPermissions = defaultMatrix;
  }
  return currentPermissions;
}

export function getPermissions(): PermissionMatrix {
  return currentPermissions;
}

export function watchPermissions(onChange: (matrix: PermissionMatrix) => void): void {
  watchFile(PERMISSIONS_FILE, { interval: 2000 }, () => {
    const matrix = loadPermissions();
    onChange(matrix);
  });
}

export function getFlashBase(): string {
  return FLASH_BASE;
}

export function getPermissionsFile(): string {
  return PERMISSIONS_FILE;
}
