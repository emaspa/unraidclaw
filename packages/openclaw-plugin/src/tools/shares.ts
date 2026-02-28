// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { UnraidClient } from "../client.js";
import { textResult, errorResult } from "./util.js";

export function registerShareTools(api: any, client: UnraidClient): void {
  api.registerTool({
    name: "unraid_share_list",
    description: "List all user shares on the Unraid server with their settings and usage.",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.get("/api/shares"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_share_details",
    description: "Get details for a specific user share by name.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Share name" },
      },
      required: ["name"],
    },
    execute: async (_id, params) => {
      try {
        return textResult(await client.get(`/api/shares/${params.name}`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
