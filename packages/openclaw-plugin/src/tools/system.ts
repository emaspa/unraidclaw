// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { ClientResolver } from "../registry.js";
import { textResult, errorResult } from "./util.js";

export function registerSystemTools(api: any, getClient: ClientResolver): void {
  api.registerTool({
    name: "unraid_system_info",
    description: "Get system information: OS (platform, hostname, uptime), CPU (model, cores, threads), memory (total, used, free, percent), and CPU load averages (1m, 5m, 15m).",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        return textResult(await getClient(params.server as string | undefined).get("/api/system/info"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_system_metrics",
    description: "Get live system metrics: memory (total, used, free bytes, percent) and CPU load averages (1m, 5m, 15m). Lightweight endpoint for polling.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        return textResult(await getClient(params.server as string | undefined).get("/api/system/metrics"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_service_list",
    description: "List system services and their current state.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        return textResult(await getClient(params.server as string | undefined).get("/api/system/services"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_system_reboot",
    description: "Reboot the Unraid server. This is a destructive operation that will interrupt all running services, VMs, and containers.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        return textResult(await getClient(params.server as string | undefined).post("/api/system/reboot"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_system_shutdown",
    description: "Shut down the Unraid server. This is a destructive operation that will power off the server.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        return textResult(await getClient(params.server as string | undefined).post("/api/system/shutdown"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
