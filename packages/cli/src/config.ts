import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { CliError, Secrets, usage } from "./errors.js";

export interface Settings { url?: string; key?: string; caCert?: string; insecure?: boolean }
export interface Environment {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  root: string;
}
export const environment = (): Environment => ({ env: process.env, home: homedir(), platform: process.platform, root: "/" });

export function remoteConfigPath(context: Environment): string {
  return context.platform === "win32"
    ? win32.join(context.env.APPDATA || win32.join(context.home, "AppData", "Roaming"), "unraidclaw", "config.json")
    : join(context.env.XDG_CONFIG_HOME || join(context.home, ".config"), "unraidclaw", "config.json");
}

export function booleanValue(value: string): boolean {
  if (["1", "true", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no"].includes(value.toLowerCase())) return false;
  return usage("Expected a boolean: true or false (also accepts 1/0 and yes/no).");
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new CliError("Cannot access configuration files.");
  }
}

export function parseCfg(text: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z_]+)="([^"\r\n]*)"\s*$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

export function gatewayUrl(value: string | undefined): URL {
  if (!value) return usage("Set the gateway URL with config set url, UNRAIDCLAW_URL or --url.");
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || url.pathname !== "/") throw new Error();
    return url;
  } catch { return usage("Gateway URL must be an http:// or https:// origin without credentials, a path, query or fragment."); }
}

function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return usage("Config must be a JSON object.");
  const settings = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(settings)) {
    if (key === "insecure" ? typeof entry !== "boolean" :
      !["url", "key", "caCert"].includes(key) || typeof entry !== "string") {
      return usage("Invalid config fields. Use url, key, caCert (strings) and insecure (boolean).");
    }
  }
  return settings as Settings;
}

export class Configuration {
  private constructor(
    readonly path: string,
    readonly file: Settings,
    readonly settings: Settings,
    readonly onServer: boolean,
    private readonly skipModes: boolean,
  ) {}

  static async load(flags: Settings & { config?: string }, context: Environment, secrets: Secrets): Promise<Configuration> {
    const flash = join(context.root, "boot");
    const base = join(flash, "config/plugins/unraidclaw");
    const cfg = join(base, "unraidclaw.cfg");
    const onServer = await exists(cfg);
    const configPath = flags.config ?? (onServer ? join(base, "cli.json") : remoteConfigPath(context));
    const path = resolve(configPath);
    const skipModes = context.platform === "win32" || (onServer && path.startsWith(resolve(flash) + sep));
    let file: Settings = {};
    try {
      const handle = await open(path, constants.O_RDONLY | (context.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) usage("Config must be a regular file.");
        if (!skipModes && (metadata.mode & 0o077)) {
          usage("Config is readable by group or others. Run chmod 600 on the config file, then try again.");
        }
        let parsed: unknown;
        try { parsed = JSON.parse(await handle.readFile("utf8")); }
        catch { usage("Cannot parse config JSON."); }
        if (parsed && typeof parsed === "object") secrets.add((parsed as Settings).key);
        file = validateSettings(parsed);
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof CliError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CliError("Cannot read config. Check its path and permissions; symlinks are not supported.");
    }
    secrets.add(context.env.UNRAIDCLAW_KEY);
    secrets.add(flags.key);
    const env = context.env;
    const insecure = env.UNRAIDCLAW_INSECURE ?? env.UNRAIDCLAW_TLS_SKIP;
    const settings: Settings = {
      url: flags.url ?? env.UNRAIDCLAW_URL ?? file.url,
      key: flags.key ?? env.UNRAIDCLAW_KEY ?? file.key,
      caCert: flags.caCert ?? env.UNRAIDCLAW_CA_CERT ?? file.caCert,
      insecure: flags.insecure ?? (insecure === undefined ? file.insecure : booleanValue(insecure)),
    };
    if (onServer && settings.url === undefined) {
      let parsed: Record<string, string>;
      try { parsed = parseCfg(await readFile(cfg, "utf8")); } catch { throw new CliError("Cannot read local gateway settings."); }
      const port = parsed.PORT ?? "9876";
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) usage("Local gateway PORT must be between 1 and 65535.");
      const cert = join(base, "tls/cert.pem");
      const tls = await exists(cert);
      settings.url = `${tls ? "https" : "http"}://127.0.0.1:${port}`;
      if (tls) settings.caCert ??= cert;
    }
    return new Configuration(path, file, settings, onServer, skipModes);
  }

  async writePrivate(path: string, contents: string): Promise<void> {
    const dir = dirname(path);
    let temporary: string | undefined;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (!this.skipModes && ((await stat(dir)).mode & 0o077)) {
        usage("Config directory must be private. Run chmod 700 on that directory, then try again.");
      }
      temporary = join(dir, `.unraidclaw-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(contents); } finally { await handle.close(); }
      await rename(temporary, path);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("Cannot write configuration. Check the path and permissions.");
    } finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async save(changes: Settings): Promise<void> {
    await this.writePrivate(this.path, JSON.stringify({ ...this.file, ...changes }, null, 2) + "\n");
  }
  /** Effective settings for display, with the key masked and unset values named. */
  masked(): { url: string; key: string; caCert: string; insecure: boolean } {
    const { url, key, caCert, insecure } = this.settings;
    return { url: url ?? "(not set)", key: key ? "[redacted]" : "(not set)", caCert: caCert ?? "(not set)", insecure: insecure === true };
  }
}
