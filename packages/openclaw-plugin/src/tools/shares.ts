import type { ToolRegistrar } from "./health.js";
import type { UnraidClient } from "../client.js";
import type { Share, CreateShareRequest, UpdateShareRequest } from "@unraidclaw/shared";

export function registerShareTools(api: ToolRegistrar, client: UnraidClient): void {
  api.register({
    name: "unraid_share_list",
    description: "List all user shares on the Unraid server with their settings and usage.",
    parameters: {},
    handler: async () => {
      return client.get<Share[]>("/api/shares");
    },
  });

  api.register({
    name: "unraid_share_create",
    description: "Create a new user share on the Unraid server.",
    parameters: {
      name: { type: "string", description: "Share name", required: true },
      comment: { type: "string", description: "Share description" },
      allocator: { type: "string", description: "Allocation method (highwater, fillup, mostfree)" },
      floor: { type: "string", description: "Minimum free space" },
      splitLevel: { type: "string", description: "Split level" },
      useCache: { type: "string", description: "Cache usage (yes, no, only, prefer)" },
    },
    handler: async (params) => {
      const body: CreateShareRequest = { name: params.name as string };
      if (params.comment) body.comment = params.comment as string;
      if (params.allocator) body.allocator = params.allocator as string;
      if (params.floor) body.floor = params.floor as string;
      if (params.splitLevel) body.splitLevel = params.splitLevel as string;
      if (params.useCache) body.useCache = params.useCache as string;
      return client.post("/api/shares", body);
    },
  });

  api.register({
    name: "unraid_share_update",
    description: "Update settings for an existing user share.",
    parameters: {
      name: { type: "string", description: "Share name", required: true },
      comment: { type: "string", description: "Share description" },
      allocator: { type: "string", description: "Allocation method" },
      floor: { type: "string", description: "Minimum free space" },
      splitLevel: { type: "string", description: "Split level" },
      useCache: { type: "string", description: "Cache usage" },
    },
    handler: async (params) => {
      const body: UpdateShareRequest = {};
      if (params.comment) body.comment = params.comment as string;
      if (params.allocator) body.allocator = params.allocator as string;
      if (params.floor) body.floor = params.floor as string;
      if (params.splitLevel) body.splitLevel = params.splitLevel as string;
      if (params.useCache) body.useCache = params.useCache as string;
      return client.patch(`/api/shares/${params.name}`, body);
    },
  });

  api.register({
    name: "unraid_share_delete",
    description: "Delete a user share. This is a destructive operation — data on the share may be lost.",
    parameters: {
      name: { type: "string", description: "Share name to delete", required: true },
    },
    optional: true,
    handler: async (params) => {
      return client.delete(`/api/shares/${params.name}`);
    },
  });
}
