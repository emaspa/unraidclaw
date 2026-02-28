import type { UnraidClient } from "../client.js";
import type { HealthResponse } from "@unraidclaw/shared";

export interface ToolRegistrar {
  register(tool: ToolDefinition): void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ParameterDef>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
  optional?: boolean;
}

export interface ParameterDef {
  type: string;
  description: string;
  required?: boolean;
  default?: unknown;
}

export function registerHealthTools(api: ToolRegistrar, client: UnraidClient): void {
  api.register({
    name: "unraid_health_check",
    description: "Check the health status of the Unraid server connection, including API and GraphQL reachability.",
    parameters: {},
    handler: async () => {
      return client.get<HealthResponse>("/api/health");
    },
  });
}
