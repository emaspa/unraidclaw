import { UnraidClient, type ClientConfig } from "./client.js";
import { registerHealthTools } from "./tools/health.js";
import { registerDockerTools } from "./tools/docker.js";
import { registerCaTools } from "./tools/ca.js";
import { registerPluginTools } from "./tools/plugins.js";
import { registerVMTools } from "./tools/vms.js";
import { registerArrayTools } from "./tools/array.js";
import { registerDiskTools } from "./tools/disks.js";
import { registerShareTools } from "./tools/shares.js";
import { registerSystemTools } from "./tools/system.js";
import { registerNotificationTools } from "./tools/notifications.js";
import { registerNetworkTools } from "./tools/network.js";
import { registerUserTools } from "./tools/users.js";
import { registerLogTools } from "./tools/logs.js";

interface ServerEntry extends ClientConfig {
  name: string;
  default?: boolean;
}

function resolveServers(api: any): ServerEntry[] {
  // Try to find raw config from various OpenClaw config shapes
  const raw = api.config?.servers ?? api.pluginConfig?.servers
    ?? api.config?.plugins?.entries?.unraidclaw?.config?.servers;

  if (Array.isArray(raw) && raw.length > 0) return raw;

  // Fall back to single-server config (backwards compatible)
  const single = api.config?.serverUrl ? api.config
    : api.pluginConfig?.serverUrl ? api.pluginConfig
    : api.config?.plugins?.entries?.unraidclaw?.config;

  if (single?.serverUrl) {
    return [{ name: "default", serverUrl: single.serverUrl, apiKey: single.apiKey, tlsSkipVerify: single.tlsSkipVerify, default: true }];
  }

  return [];
}

export type ClientResolver = (serverName?: string) => UnraidClient;

export default function register(api: any): void {
  const log = api.logger || console;

  // Client pool keyed by server name, built lazily
  const clients = new Map<string, UnraidClient>();

  function getClient(serverName?: string): UnraidClient {
    const servers = resolveServers(api);
    if (servers.length === 0) {
      // Return a client that will fail with a clear error at request time
      return new UnraidClient(() => ({ serverUrl: "", apiKey: "" }));
    }

    const target = serverName
      ? servers.find((s) => s.name === serverName)
      : servers.find((s) => s.default) ?? servers[0];

    if (!target) {
      throw new Error(`Server "${serverName}" not found. Available: ${servers.map((s) => s.name).join(", ")}`);
    }

    let client = clients.get(target.name);
    if (!client) {
      client = new UnraidClient(() => ({ serverUrl: target.serverUrl, apiKey: target.apiKey, tlsSkipVerify: target.tlsSkipVerify }));
      clients.set(target.name, client);
    }
    return client;
  }

  registerHealthTools(api, getClient);
  registerDockerTools(api, getClient);
  registerCaTools(api, getClient);
  registerPluginTools(api, getClient);
  registerVMTools(api, getClient);
  registerArrayTools(api, getClient);
  registerDiskTools(api, getClient);
  registerShareTools(api, getClient);
  registerSystemTools(api, getClient);
  registerNotificationTools(api, getClient);
  registerNetworkTools(api, getClient);
  registerUserTools(api, getClient);
  registerLogTools(api, getClient);

  const servers = resolveServers(api);
  if (servers.length > 1) {
    log.info(`UnraidClaw: registered tools for ${servers.length} servers: ${servers.map((s) => s.name).join(", ")}`);
  } else if (servers.length === 1) {
    log.info(`UnraidClaw: registered tools, server: ${servers[0].serverUrl}`);
  } else {
    log.info(`UnraidClaw: registered tools (config will resolve at runtime)`);
  }
}
