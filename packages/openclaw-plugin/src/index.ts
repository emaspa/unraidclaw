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
import { registerLogTools } from "./tools/logs.js";

function resolveConfig(api: any): { serverUrl: string; apiKey: string } {
  // Try direct plugin config
  if (api.config?.serverUrl) return api.config;
  // Try pluginConfig
  if (api.pluginConfig?.serverUrl) return api.pluginConfig;
  // Try nested in full config
  const nested = api.config?.plugins?.entries?.unraidclaw?.config;
  if (nested?.serverUrl) return nested;
  // Return empty — will fail at tool execution time with a clear error
  return { serverUrl: "", apiKey: "" };
}

export default function register(api: any): void {
  const log = api.logger || console;

  // Lazy config resolution — config may not be available at install time
  const client = new UnraidClient(() => resolveConfig(api));

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
  registerLogTools(api, client);

  const cfg = resolveConfig(api);
  log.info(`UnraidClaw: registered 38 tools${cfg.serverUrl ? ", server: " + cfg.serverUrl : " (config will resolve at runtime)"}`);
}
