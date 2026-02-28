/** Minimal OpenClaw plugin API types */

export interface OpenClawApi {
  config: PluginConfig;
  logger: Logger;
  registerTool(tool: ToolDefinition, options?: ToolOptions): void;
}

export interface PluginConfig {
  serverUrl: string;
  apiKey: string;
}

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolOptions {
  optional?: boolean;
}

export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}
