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
}
