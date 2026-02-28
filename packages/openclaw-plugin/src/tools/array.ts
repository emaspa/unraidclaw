import type { OpenClawApi } from "../types.js";
import type { UnraidClient } from "../client.js";
import { textResult, errorResult } from "./util.js";

export function registerArrayTools(api: OpenClawApi, client: UnraidClient): void {
  api.registerTool({
    name: "unraid_array_status",
    description: "Get the current status of the Unraid array including state, capacity, disks, and parity history.",
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
    description: "Start a parity check or parity-sync/data-rebuild operation.",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.post("/api/array/parity/start"));
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
