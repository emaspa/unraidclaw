import type { ToolRegistrar } from "./health.js";
import type { UnraidClient } from "../client.js";
import type { DiskInfo } from "@unraidclaw/shared";

export function registerDiskTools(api: ToolRegistrar, client: UnraidClient): void {
  api.register({
    name: "unraid_disk_list",
    description: "List all disks in the Unraid server with basic info (name, size, temp, status).",
    parameters: {},
    handler: async () => {
      return client.get<DiskInfo[]>("/api/disks");
    },
  });

  api.register({
    name: "unraid_disk_details",
    description: "Get detailed information about a specific disk including SMART data and health status.",
    parameters: {
      id: { type: "string", description: "Disk ID (e.g., 'disk1', 'parity')", required: true },
    },
    handler: async (params) => {
      return client.get<DiskInfo>(`/api/disks/${params.id}`);
    },
  });
}
