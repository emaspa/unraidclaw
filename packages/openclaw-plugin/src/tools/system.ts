import type { ToolRegistrar } from "./health.js";
import type { UnraidClient } from "../client.js";
import type { SystemInfo, SystemMetrics, ServiceInfo } from "@unraidclaw/shared";

export function registerSystemTools(api: ToolRegistrar, client: UnraidClient): void {
  api.register({
    name: "unraid_system_info",
    description: "Get system information including OS, CPU, memory, and Unraid/kernel versions.",
    parameters: {},
    handler: async () => {
      return client.get<SystemInfo>("/api/system/info");
    },
  });

  api.register({
    name: "unraid_system_metrics",
    description: "Get live system metrics: CPU usage, memory usage, load average, and uptime.",
    parameters: {},
    handler: async () => {
      return client.get<SystemMetrics>("/api/system/metrics");
    },
  });

  api.register({
    name: "unraid_service_list",
    description: "List system services and their current state.",
    parameters: {},
    handler: async () => {
      return client.get<ServiceInfo[]>("/api/system/services");
    },
  });

  api.register({
    name: "unraid_system_reboot",
    description: "Reboot the Unraid server. This is a destructive operation that will interrupt all running services, VMs, and containers.",
    parameters: {},
    optional: true,
    handler: async () => {
      return client.post("/api/system/reboot");
    },
  });

  api.register({
    name: "unraid_system_shutdown",
    description: "Shut down the Unraid server. This is a destructive operation that will power off the server.",
    parameters: {},
    optional: true,
    handler: async () => {
      return client.post("/api/system/shutdown");
    },
  });
}
