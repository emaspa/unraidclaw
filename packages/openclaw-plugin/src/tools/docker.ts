// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { UnraidClient } from "../client.js";
import { textResult, errorResult } from "./util.js";

export function registerDockerTools(api: any, client: UnraidClient): void {
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

  api.registerTool({
    name: "unraid_docker_remove",
    description: "Remove a Docker container. Pass force=true to stop and remove in one step. This is a destructive operation that cannot be undone.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container ID or name" },
        force: { type: "boolean", description: "Stop the container before removing (default: false)" },
      },
      required: ["id"],
    },
    execute: async (_id, params) => {
      try {
        const query = params.force ? "?force=true" : "";
        return textResult(await client.delete(`/api/docker/containers/${params.id}${query}`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_docker_create",
    description:
      "Create and start a new Docker container on the Unraid server. Specify image, optional name, port mappings, volume mounts, environment variables, restart policy, and network.",
    parameters: {
      type: "object",
      properties: {
        image: { type: "string", description: "Docker image to use (e.g. vikunja/vikunja:latest)" },
        name: { type: "string", description: "Optional container name" },
        ports: {
          type: "array",
          items: { type: "string" },
          description: "Port mappings in host:container format (e.g. ['3456:3456'])",
        },
        volumes: {
          type: "array",
          items: { type: "string" },
          description: "Volume mounts in host:container format (e.g. ['/mnt/cache/appdata/vikunja:/app/vikunja'])",
        },
        env: {
          type: "array",
          items: { type: "string" },
          description: "Environment variables in KEY=VALUE format",
        },
        restart: {
          type: "string",
          enum: ["no", "always", "unless-stopped", "on-failure"],
          description: "Restart policy (default: unless-stopped)",
        },
        network: { type: "string", description: "Network to attach the container to" },
      },
      required: ["image"],
    },
    execute: async (_id, params) => {
      try {
        return textResult(await client.post("/api/docker/containers", params));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
