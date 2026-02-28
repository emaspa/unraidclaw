import type { OpenClawApi } from "../types.js";
import type { UnraidClient } from "../client.js";
import { textResult, errorResult } from "./util.js";

export function registerHealthTools(api: OpenClawApi, client: UnraidClient): void {
  api.registerTool({
    name: "unraid_health_check",
    description: "Check the health status of the Unraid server connection, including API and GraphQL reachability.",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.get("/api/health"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
