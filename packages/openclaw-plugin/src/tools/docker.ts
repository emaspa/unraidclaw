import type { OpenClawApi } from "../types.js";
import type { UnraidClient } from "../client.js";
import { textResult, errorResult } from "./util.js";

export function registerDockerTools(api: OpenClawApi, client: UnraidClient): void {
  api.registerTool({
    name: "unraid_docker_list",
    description: "List all Docker containers on the Unraid server with their current state, image, and status.",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.get("/api/docker/containers"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_docker_inspect",
    description: "Get detailed information about a specific Docker container including ports, mounts, and network mode.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container ID or name" },
      },
      required: ["id"],
    },
    execute: async (_id, params) => {
      try {
        return textResult(await client.get(`/api/docker/containers/${params.id}`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_docker_logs",
    description: "Get logs from a specific Docker container.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container ID or name" },
        tail: { type: "number", description: "Number of lines from the end (default: 100)" },
        since: { type: "string", description: "Show logs since timestamp (e.g., 2024-01-01T00:00:00Z)" },
      },
      required: ["id"],
    },
    execute: async (_id, params) => {
      try {
        const query: Record<string, string> = {};
        if (params.tail) query.tail = String(params.tail);
        if (params.since) query.since = String(params.since);
        return textResult(await client.get(`/api/docker/containers/${params.id}/logs`, query));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_docker_start",
    description: "Start a stopped Docker container.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container ID or name" },
      },
      required: ["id"],
    },
    execute: async (_id, params) => {
      try {
        return textResult(await client.post(`/api/docker/containers/${params.id}/start`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_docker_stop",
    description: "Stop a running Docker container.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container ID or name" },
      },
      required: ["id"],
    },
    execute: async (_id, params) => {
      try {
        return textResult(await client.post(`/api/docker/containers/${params.id}/stop`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_docker_restart",
    description: "Restart a Docker container.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container ID or name" },
      },
      required: ["id"],
    },
    execute: async (_id, params) => {
      try {
        return textResult(await client.post(`/api/docker/containers/${params.id}/restart`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_docker_pause",
    description: "Pause a running Docker container (freeze all processes).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container ID or name" },
      },
      required: ["id"],
    },
    execute: async (_id, params) => {
      try {
        return textResult(await client.post(`/api/docker/containers/${params.id}/pause`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_docker_unpause",
    description: "Unpause a paused Docker container.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container ID or name" },
      },
      required: ["id"],
    },
    execute: async (_id, params) => {
      try {
        return textResult(await client.post(`/api/docker/containers/${params.id}/unpause`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool(
    {
      name: "unraid_docker_remove",
      description: "Remove a Docker container. This is a destructive operation that cannot be undone.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Container ID or name" },
        },
        required: ["id"],
      },
      execute: async (_id, params) => {
        try {
          return textResult(await client.delete(`/api/docker/containers/${params.id}`));
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    { optional: true }
  );
}
