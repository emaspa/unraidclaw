import type { ToolRegistrar } from "./health.js";
import type { UnraidClient } from "../client.js";
import type { DockerContainer, DockerContainerDetail, DockerActionResponse, DockerLogsResponse } from "@unraidclaw/shared";

export function registerDockerTools(api: ToolRegistrar, client: UnraidClient): void {
  api.register({
    name: "unraid_docker_list",
    description: "List all Docker containers on the Unraid server with their current state, image, and status.",
    parameters: {},
    handler: async () => {
      return client.get<DockerContainer[]>("/api/docker/containers");
    },
  });

  api.register({
    name: "unraid_docker_inspect",
    description: "Get detailed information about a specific Docker container including ports, mounts, and network mode.",
    parameters: {
      id: { type: "string", description: "Container ID or name", required: true },
    },
    handler: async (params) => {
      return client.get<DockerContainerDetail>(`/api/docker/containers/${params.id}`);
    },
  });

  api.register({
    name: "unraid_docker_logs",
    description: "Get logs from a specific Docker container.",
    parameters: {
      id: { type: "string", description: "Container ID or name", required: true },
      tail: { type: "number", description: "Number of lines from the end", default: 100 },
      since: { type: "string", description: "Show logs since timestamp (e.g., 2024-01-01T00:00:00Z)" },
    },
    handler: async (params) => {
      const query: Record<string, string> = {};
      if (params.tail) query.tail = String(params.tail);
      if (params.since) query.since = String(params.since);
      return client.get<DockerLogsResponse>(`/api/docker/containers/${params.id}/logs`, query);
    },
  });

  api.register({
    name: "unraid_docker_start",
    description: "Start a stopped Docker container.",
    parameters: {
      id: { type: "string", description: "Container ID or name", required: true },
    },
    handler: async (params) => {
      return client.post<DockerActionResponse>(`/api/docker/containers/${params.id}/start`);
    },
  });

  api.register({
    name: "unraid_docker_stop",
    description: "Stop a running Docker container.",
    parameters: {
      id: { type: "string", description: "Container ID or name", required: true },
    },
    handler: async (params) => {
      return client.post<DockerActionResponse>(`/api/docker/containers/${params.id}/stop`);
    },
  });

  api.register({
    name: "unraid_docker_restart",
    description: "Restart a Docker container.",
    parameters: {
      id: { type: "string", description: "Container ID or name", required: true },
    },
    handler: async (params) => {
      return client.post<DockerActionResponse>(`/api/docker/containers/${params.id}/restart`);
    },
  });

  api.register({
    name: "unraid_docker_pause",
    description: "Pause a running Docker container (freeze all processes).",
    parameters: {
      id: { type: "string", description: "Container ID or name", required: true },
    },
    handler: async (params) => {
      return client.post<DockerActionResponse>(`/api/docker/containers/${params.id}/pause`);
    },
  });

  api.register({
    name: "unraid_docker_unpause",
    description: "Unpause a paused Docker container.",
    parameters: {
      id: { type: "string", description: "Container ID or name", required: true },
    },
    handler: async (params) => {
      return client.post<DockerActionResponse>(`/api/docker/containers/${params.id}/unpause`);
    },
  });

  api.register({
    name: "unraid_docker_remove",
    description: "Remove a Docker container. This is a destructive operation that cannot be undone.",
    parameters: {
      id: { type: "string", description: "Container ID or name", required: true },
    },
    optional: true,
    handler: async (params) => {
      return client.delete<DockerActionResponse>(`/api/docker/containers/${params.id}`);
    },
  });
}
