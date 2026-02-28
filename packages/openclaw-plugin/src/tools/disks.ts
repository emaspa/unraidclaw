// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { UnraidClient } from "../client.js";
import { textResult, errorResult } from "./util.js";

export function registerDiskTools(api: any, client: UnraidClient): void {
  api.registerTool({
    name: "unraid_disk_list",
    description: "List all disks in the Unraid server with basic info (name, size, temp, status).",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.get("/api/disks"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_disk_details",
    description: "Get detailed information about a specific disk including SMART data and health status.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Disk ID (e.g., 'disk1', 'parity')" },
      },
      required: ["id"],
    },
    execute: async (_id, params) => {
      try {
        return textResult(await client.get(`/api/disks/${params.id}`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
