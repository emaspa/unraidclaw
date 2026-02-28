import type { ToolRegistrar } from "./health.js";
import type { UnraidClient } from "../client.js";
import type { ArrayStatus, ParityActionResponse } from "@unraidclaw/shared";

export function registerArrayTools(api: ToolRegistrar, client: UnraidClient): void {
  api.register({
    name: "unraid_array_status",
    description: "Get the current status of the Unraid array including state, capacity, disks, and parity history.",
    parameters: {},
    handler: async () => {
      return client.get<ArrayStatus>("/api/array/status");
    },
  });

  api.register({
    name: "unraid_parity_status",
    description: "Get the current parity check status (running, progress, speed, errors).",
    parameters: {},
    handler: async () => {
      return client.get("/api/array/parity/status");
    },
  });

  api.register({
    name: "unraid_parity_start",
    description: "Start a parity check or parity-sync/data-rebuild operation.",
    parameters: {},
    handler: async () => {
      return client.post<ParityActionResponse>("/api/array/parity/start");
    },
  });

  api.register({
    name: "unraid_parity_pause",
    description: "Pause a running parity check.",
    parameters: {},
    handler: async () => {
      return client.post<ParityActionResponse>("/api/array/parity/pause");
    },
  });

  api.register({
    name: "unraid_parity_resume",
    description: "Resume a paused parity check.",
    parameters: {},
    handler: async () => {
      return client.post<ParityActionResponse>("/api/array/parity/resume");
    },
  });

  api.register({
    name: "unraid_parity_cancel",
    description: "Cancel a running or paused parity check.",
    parameters: {},
    handler: async () => {
      return client.post<ParityActionResponse>("/api/array/parity/cancel");
    },
  });
}
