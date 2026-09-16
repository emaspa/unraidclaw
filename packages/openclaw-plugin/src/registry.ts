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

import type { ToolDefinition, ToolOptions } from "./types.js";
export type { ToolDefinition, ToolOptions, ToolResult } from "./types.js";
export { isErrorResult } from "./tools/util.js";

/** The tools depend only on this transport, not on an HTTP client or host. */
export interface ToolClient {
  get<T>(path: string, query?: Record<string, string>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

export type ClientResolver = (serverName?: string) => ToolClient;

export function registerTools(
  api: { registerTool(tool: ToolDefinition, options?: ToolOptions): void },
  getClient: ClientResolver,
): void {
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
}
