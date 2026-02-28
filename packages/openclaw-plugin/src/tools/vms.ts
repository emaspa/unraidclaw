import type { ToolRegistrar } from "./health.js";
import type { UnraidClient } from "../client.js";
import type { VM, VMActionResponse } from "@unraidclaw/shared";

export function registerVMTools(api: ToolRegistrar, client: UnraidClient): void {
  api.register({
    name: "unraid_vm_list",
    description: "List all virtual machines on the Unraid server with their current state.",
    parameters: {},
    handler: async () => {
      return client.get<VM[]>("/api/vms");
    },
  });

  api.register({
    name: "unraid_vm_inspect",
    description: "Get detailed information about a specific virtual machine.",
    parameters: {
      id: { type: "string", description: "VM ID or name", required: true },
    },
    handler: async (params) => {
      return client.get<VM>(`/api/vms/${params.id}`);
    },
  });

  api.register({
    name: "unraid_vm_start",
    description: "Start a stopped virtual machine.",
    parameters: {
      id: { type: "string", description: "VM ID or name", required: true },
    },
    handler: async (params) => {
      return client.post<VMActionResponse>(`/api/vms/${params.id}/start`);
    },
  });

  api.register({
    name: "unraid_vm_stop",
    description: "Gracefully stop a running virtual machine (ACPI shutdown).",
    parameters: {
      id: { type: "string", description: "VM ID or name", required: true },
    },
    handler: async (params) => {
      return client.post<VMActionResponse>(`/api/vms/${params.id}/stop`);
    },
  });

  api.register({
    name: "unraid_vm_pause",
    description: "Pause a running virtual machine (suspend to RAM).",
    parameters: {
      id: { type: "string", description: "VM ID or name", required: true },
    },
    handler: async (params) => {
      return client.post<VMActionResponse>(`/api/vms/${params.id}/pause`);
    },
  });

  api.register({
    name: "unraid_vm_resume",
    description: "Resume a paused virtual machine.",
    parameters: {
      id: { type: "string", description: "VM ID or name", required: true },
    },
    handler: async (params) => {
      return client.post<VMActionResponse>(`/api/vms/${params.id}/resume`);
    },
  });

  api.register({
    name: "unraid_vm_force_stop",
    description: "Force stop a virtual machine (equivalent to pulling the power plug). This is destructive and may cause data loss.",
    parameters: {
      id: { type: "string", description: "VM ID or name", required: true },
    },
    optional: true,
    handler: async (params) => {
      return client.post<VMActionResponse>(`/api/vms/${params.id}/force-stop`);
    },
  });

  api.register({
    name: "unraid_vm_reboot",
    description: "Reboot a running virtual machine (ACPI reboot).",
    parameters: {
      id: { type: "string", description: "VM ID or name", required: true },
    },
    optional: true,
    handler: async (params) => {
      return client.post<VMActionResponse>(`/api/vms/${params.id}/reboot`);
    },
  });
}
