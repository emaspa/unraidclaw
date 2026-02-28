import type { ToolRegistrar } from "./health.js";
import type { UnraidClient } from "../client.js";
import type { NetworkInfo } from "@unraidclaw/shared";

export function registerNetworkTools(api: ToolRegistrar, client: UnraidClient): void {
  api.register({
    name: "unraid_network_info",
    description: "Get network information including hostname, gateway, DNS servers, and all network interfaces.",
    parameters: {},
    handler: async () => {
      return client.get<NetworkInfo>("/api/network");
    },
  });
}
