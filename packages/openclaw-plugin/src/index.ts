import { UnraidClient } from "./client.js";
import { registerHealthTools } from "./tools/health.js";
import { registerDockerTools } from "./tools/docker.js";
import { registerVMTools } from "./tools/vms.js";
import { registerArrayTools } from "./tools/array.js";
import { registerDiskTools } from "./tools/disks.js";
import { registerShareTools } from "./tools/shares.js";
import { registerSystemTools } from "./tools/system.js";
import { registerNotificationTools } from "./tools/notifications.js";
import { registerNetworkTools } from "./tools/network.js";
import { registerUserTools } from "./tools/users.js";

function resolveConfig(api: any): { serverUrl: string; apiKey: string } | null {
  // Try direct plugin config
  if (api.config?.serverUrl) return api.config;
  // Try pluginConfig
  if (api.pluginConfig?.serverUrl) return api.pluginConfig;
  // Try nested in full config
  const nested = api.config?.plugins?.entries?.unraidclaw?.config;
  if (nested?.serverUrl) return nested;
  return null;
}

export default function register(api: any): void {
  const log = api.logger || console;
  const cfg = resolveConfig(api);

  if (!cfg) {
    log.error("UnraidClaw: could not find serverUrl/apiKey in config. Keys on api:", Object.keys(api));
    log.error("UnraidClaw: api.config =", JSON.stringify(api.config)?.substring(0, 500));
    return;
  }

  const client = new UnraidClient({
    serverUrl: cfg.serverUrl,
    apiKey: cfg.apiKey,
  });

  registerHealthTools(api, client);
  registerDockerTools(api, client);
  registerVMTools(api, client);
  registerArrayTools(api, client);
  registerDiskTools(api, client);
  registerShareTools(api, client);
  registerSystemTools(api, client);
  registerNotificationTools(api, client);
  registerNetworkTools(api, client);
  registerUserTools(api, client);

  log.info("UnraidClaw: registered 37 tools, server:", cfg.serverUrl);
}
