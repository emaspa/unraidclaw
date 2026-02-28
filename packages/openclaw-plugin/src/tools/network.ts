import type { OpenClawApi } from "../types.js";
import type { UnraidClient } from "../client.js";
import { textResult, errorResult } from "./util.js";

export function registerNetworkTools(api: OpenClawApi, client: UnraidClient): void {
  api.registerTool({
    name: "unraid_network_info",
    description: "Get network information including hostname, gateway, DNS servers, and all network interfaces.",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.get("/api/network"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
