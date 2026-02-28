// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { UnraidClient } from "../client.js";
import { textResult, errorResult } from "./util.js";

export function registerArrayTools(api: any, client: UnraidClient): void {
  api.registerTool({
    name: "unraid_array_status",
    description: "Get the current status of the Unraid array including state, capacity, disks, and parities.",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.get("/api/array/status"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_array_start",
    description: "Start the Unraid array. This will mount all disks and start Docker/VMs if configured.",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.post("/api/array/start"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_array_stop",
    description: "Stop the Unraid array. This will stop all Docker containers and VMs, then unmount all disks.",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.post("/api/array/stop"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_parity_status",
    description: "Get the current parity check status (running, progress, speed, errors).",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.get("/api/array/parity/status"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_parity_start",
    description: "Start a parity check. Defaults to non-correcting (read-only) for safety. Set correct=true for a correcting check.",
    parameters: {
      type: "object",
      properties: {
        correct: {
          type: "boolean",
          description: "If true, run a correcting parity check. Defaults to false (non-correcting).",
        },
      },
    },
    execute: async (_id: string, params: { correct?: boolean }) => {
      try {
        return textResult(await client.post("/api/array/parity/start", { correct: params.correct ?? false }));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_parity_pause",
    description: "Pause a running parity check.",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.post("/api/array/parity/pause"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_parity_resume",
    description: "Resume a paused parity check.",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.post("/api/array/parity/resume"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_parity_cancel",
    description: "Cancel a running or paused parity check.",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.post("/api/array/parity/cancel"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
