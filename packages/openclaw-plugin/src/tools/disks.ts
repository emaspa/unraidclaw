// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { ClientResolver } from "../registry.js";
import { textResult, errorResult } from "./util.js";

export function registerDiskTools(api: any, getClient: ClientResolver): void {
  api.registerTool({
    name: "unraid_disk_list",
    description: "List all disks (data + parity) with name, size, used, free, usedPercent, temp, status, and fsType.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        return textResult(await getClient(params.server as string | undefined).get("/api/disks"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_disk_details",
    description: "Get details for a specific disk: size, used, free, usedPercent, temp, status, and fsType.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Disk ID (e.g., 'disk1', 'parity')" },
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      required: ["id"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        return textResult(await getClient(params.server as string | undefined).get(`/api/disks/${params.id}`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
