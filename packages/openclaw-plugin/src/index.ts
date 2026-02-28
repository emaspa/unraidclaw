import { UnraidClient, type ClientConfig } from "./client.js";
import type { ToolRegistrar } from "./tools/health.js";
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

export { UnraidClient, UnraidApiError } from "./client.js";
export type { ClientConfig } from "./client.js";
export type { ToolRegistrar, ToolDefinition, ParameterDef } from "./tools/health.js";

export interface PluginConfig {
  serverUrl: string;
  apiKey: string;
}

export function register(api: ToolRegistrar, config: PluginConfig): void {
  const clientConfig: ClientConfig = {
    serverUrl: config.serverUrl,
    apiKey: config.apiKey,
  };

  const client = new UnraidClient(clientConfig);

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
}
