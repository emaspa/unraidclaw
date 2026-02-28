// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { UnraidClient } from "../client.js";
import { textResult, errorResult } from "./util.js";

export function registerShareTools(api: any, client: UnraidClient): void {
  api.registerTool({
    name: "unraid_share_list",
    description: "List all user shares on the Unraid server with their settings and usage.",
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
    name: "unraid_share_create",
    description: "Create a new user share on the Unraid server.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Share name" },
        comment: { type: "string", description: "Share description" },
        allocator: { type: "string", description: "Allocation method (highwater, fillup, mostfree)" },
        floor: { type: "string", description: "Minimum free space" },
        splitLevel: { type: "string", description: "Split level" },
        useCache: { type: "string", description: "Cache usage (yes, no, only, prefer)" },
      },
      required: ["name"],
    },
    execute: async (_id, params) => {
      try {
        const body: Record<string, string> = { name: params.name as string };
        if (params.comment) body.comment = params.comment as string;
        if (params.allocator) body.allocator = params.allocator as string;
        if (params.floor) body.floor = params.floor as string;
        if (params.splitLevel) body.splitLevel = params.splitLevel as string;
        if (params.useCache) body.useCache = params.useCache as string;
        return textResult(await client.post("/api/shares", body));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_share_update",
    description: "Update settings for an existing user share.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Share name" },
        comment: { type: "string", description: "Share description" },
        allocator: { type: "string", description: "Allocation method" },
        floor: { type: "string", description: "Minimum free space" },
        splitLevel: { type: "string", description: "Split level" },
        useCache: { type: "string", description: "Cache usage" },
      },
      required: ["name"],
    },
    execute: async (_id, params) => {
      try {
        const body: Record<string, string> = {};
        if (params.comment) body.comment = params.comment as string;
        if (params.allocator) body.allocator = params.allocator as string;
        if (params.floor) body.floor = params.floor as string;
        if (params.splitLevel) body.splitLevel = params.splitLevel as string;
        if (params.useCache) body.useCache = params.useCache as string;
        return textResult(await client.patch(`/api/shares/${params.name}`, body));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool(
    {
      name: "unraid_share_delete",
      description: "Delete a user share. This is a destructive operation — data on the share may be lost.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Share name to delete" },
        },
        required: ["name"],
      },
      execute: async (_id, params) => {
        try {
          return textResult(await client.delete(`/api/shares/${params.name}`));
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    { optional: true }
  );
}
