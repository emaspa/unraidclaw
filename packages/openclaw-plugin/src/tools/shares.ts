// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { UnraidClient } from "../client.js";
import { textResult, errorResult } from "./util.js";

export function registerShareTools(api: any, client: UnraidClient): void {
  api.registerTool({
    name: "unraid_share_list",
    description: "List all user shares on the Unraid server with their settings and usage. The 'free' and 'size' fields are in kilobytes (KiB).",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.get("/api/shares"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_share_details",
    description: "Get details for a specific user share by name. The 'free' and 'size' fields are in kilobytes (KiB).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Share name" },
      },
      required: ["name"],
    },
    execute: async (_id: string, params: { name: string }) => {
      try {
        return textResult(await client.get(`/api/shares/${params.name}`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_share_update",
    description: "Update safe settings for a user share. Only affects metadata and future write behavior — does not move existing data.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Share name to update" },
        comment: { type: "string", description: "Share description/comment" },
        allocator: { type: "string", description: "Disk allocation method: highwater, fill, or most-free" },
        floor: { type: "string", description: "Minimum free space per disk (e.g. '0' or '50000')" },
        splitLevel: { type: "string", description: "Split level for distributing files across disks" },
      },
      required: ["name"],
    },
    execute: async (_id: string, params: { name: string; comment?: string; allocator?: string; floor?: string; splitLevel?: string }) => {
      try {
        const { name, ...updates } = params;
        return textResult(await client.patch(`/api/shares/${name}`, updates));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
