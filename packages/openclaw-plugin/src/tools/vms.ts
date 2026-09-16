// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { ClientResolver } from "../registry.js";
import { textResult, errorResult } from "./util.js";

export function registerVMTools(api: any, getClient: ClientResolver): void {
  api.registerTool({
    name: "unraid_vm_list",
    description: "List all virtual machines on the Unraid server with their current state.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        return textResult(await getClient(params.server as string | undefined).get("/api/vms"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  for (const [name, desc, action] of [
    ["unraid_vm_inspect", "Get detailed information about a specific virtual machine.", null],
    ["unraid_vm_start", "Start a stopped virtual machine.", "start"],
    ["unraid_vm_stop", "Gracefully stop a running virtual machine (ACPI shutdown).", "stop"],
    ["unraid_vm_pause", "Pause a running virtual machine (suspend to RAM).", "pause"],
    ["unraid_vm_resume", "Resume a paused virtual machine.", "resume"],
    ["unraid_vm_force_stop", "Force stop a virtual machine (equivalent to pulling the power plug). This is destructive and may cause data loss.", "force-stop"],
    ["unraid_vm_reboot", "Reboot a running virtual machine (ACPI reboot).", "reboot"],
  ] as const) {
    api.registerTool(
      {
        name,
        description: desc,
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "VM ID or name" },
            server: { type: "string", description: "Target server name (optional, uses default server)" },
          },
          required: ["id"],
        },
        execute: async (_id: string, params: Record<string, unknown>) => {
          try {
            const client = getClient(params.server as string | undefined);
            if (action) {
              return textResult(await client.post(`/api/vms/${params.id}/${action}`));
            }
            return textResult(await client.get(`/api/vms/${params.id}`));
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      ...(name === "unraid_vm_force_stop" ? [{ optional: true }] : []),
    );
  }
}
