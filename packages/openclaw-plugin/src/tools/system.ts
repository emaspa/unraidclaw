// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { UnraidClient } from "../client.js";
import { textResult, errorResult } from "./util.js";

export function registerSystemTools(api: any, client: UnraidClient): void {
  api.registerTool({
    name: "unraid_system_info",
    description: "Get system information including OS, CPU, memory, and Unraid/kernel versions.",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.get("/api/system/info"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_system_metrics",
    description: "Get live system metrics: CPU usage, memory usage, load average, and uptime.",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.get("/api/system/metrics"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_service_list",
    description: "List system services and their current state.",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.get("/api/system/services"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool(
    {
      name: "unraid_system_reboot",
      description: "Reboot the Unraid server. This is a destructive operation that will interrupt all running services, VMs, and containers.",
      parameters: { type: "object" },
      execute: async () => {
        try {
          return textResult(await client.post("/api/system/reboot"));
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    { optional: true }
  );

  api.registerTool(
    {
      name: "unraid_system_shutdown",
      description: "Shut down the Unraid server. This is a destructive operation that will power off the server.",
      parameters: { type: "object" },
      execute: async () => {
        try {
          return textResult(await client.post("/api/system/shutdown"));
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    { optional: true }
  );
}
