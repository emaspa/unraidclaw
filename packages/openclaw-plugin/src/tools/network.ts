// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { UnraidClient } from "../client.js";
import { textResult, errorResult } from "./util.js";

export function registerNetworkTools(api: any, client: UnraidClient): void {
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
