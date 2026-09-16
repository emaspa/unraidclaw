// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { ClientResolver } from "../registry.js";
import { textResult, errorResult } from "./util.js";

export function registerNetworkTools(api: any, getClient: ClientResolver): void {
  api.registerTool({
    name: "unraid_network_info",
    description: "Get network information including hostname, gateway, DNS servers, and all network interfaces.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        return textResult(await getClient(params.server as string | undefined).get("/api/network"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
