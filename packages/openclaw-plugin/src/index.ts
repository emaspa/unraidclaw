import type { OpenClawApi } from "./types.js";
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

export default function register(api: OpenClawApi): void {
  const client = new UnraidClient({
    serverUrl: api.config.serverUrl,
    apiKey: api.config.apiKey,
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

  api.logger.info("UnraidClaw plugin registered 37 tools");
}
