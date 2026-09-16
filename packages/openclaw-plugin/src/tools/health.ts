// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { ClientResolver } from "../registry.js";
import { textResult, errorResult } from "./util.js";

export function registerHealthTools(api: any, getClient: ClientResolver): void {
  api.registerTool({
    name: "unraid_health_check",
    description: "Check the health status of the Unraid server connection, including API and GraphQL reachability.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        return textResult(await getClient(params.server as string | undefined).get("/api/health"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
