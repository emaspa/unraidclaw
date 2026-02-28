import type { OpenClawApi } from "../types.js";
import type { UnraidClient } from "../client.js";
import { textResult, errorResult } from "./util.js";

export function registerVMTools(api: OpenClawApi, client: UnraidClient): void {
  api.registerTool({
    name: "unraid_vm_list",
    description: "List all virtual machines on the Unraid server with their current state.",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.get("/api/vms"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_vm_inspect",
    description: "Get detailed information about a specific virtual machine.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "VM ID or name" },
      },
      required: ["id"],
    },
    execute: async (_id, params) => {
      try {
        return textResult(await client.get(`/api/vms/${params.id}`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_vm_start",
    description: "Start a stopped virtual machine.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "VM ID or name" },
      },
      required: ["id"],
    },
    execute: async (_id, params) => {
      try {
        return textResult(await client.post(`/api/vms/${params.id}/start`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_vm_stop",
    description: "Gracefully stop a running virtual machine (ACPI shutdown).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "VM ID or name" },
      },
      required: ["id"],
    },
    execute: async (_id, params) => {
      try {
        return textResult(await client.post(`/api/vms/${params.id}/stop`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_vm_pause",
    description: "Pause a running virtual machine (suspend to RAM).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "VM ID or name" },
      },
      required: ["id"],
    },
    execute: async (_id, params) => {
      try {
        return textResult(await client.post(`/api/vms/${params.id}/pause`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_vm_resume",
    description: "Resume a paused virtual machine.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "VM ID or name" },
      },
      required: ["id"],
    },
    execute: async (_id, params) => {
      try {
        return textResult(await client.post(`/api/vms/${params.id}/resume`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool(
    {
      name: "unraid_vm_force_stop",
      description: "Force stop a virtual machine (equivalent to pulling the power plug). This is destructive and may cause data loss.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "VM ID or name" },
        },
        required: ["id"],
      },
      execute: async (_id, params) => {
        try {
          return textResult(await client.post(`/api/vms/${params.id}/force-stop`));
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    { optional: true }
  );

  api.registerTool(
    {
      name: "unraid_vm_reboot",
      description: "Reboot a running virtual machine (ACPI reboot).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "VM ID or name" },
        },
        required: ["id"],
      },
      execute: async (_id, params) => {
        try {
          return textResult(await client.post(`/api/vms/${params.id}/reboot`));
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    { optional: true }
  );
}
