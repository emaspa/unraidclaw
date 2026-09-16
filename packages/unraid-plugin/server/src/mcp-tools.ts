import Ajv from "ajv";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { registerTools, isErrorResult, READ_ONLY, type ToolClient, type ToolDefinition, type ToolOptions } from "unraidclaw/tools";
import type { ApiResponse } from "@unraidclaw/shared";
import { recordMcpApiCall } from "./mcp-log.js";
import { mcpApiKey } from "./mcp-security.js";

function collectTools(client: ToolClient) {
  const tools = new Map<string, { tool: ToolDefinition; options?: ToolOptions }>();
  registerTools({ registerTool: (tool, options) => { tools.set(tool.name, { tool, options }); } }, () => client);
  return tools;
}

function injectedClient(app: FastifyInstance, request: FastifyRequest): ToolClient {
  async function send<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    // The definitions are trusted, but this adapter must never become a network
    // client or permit a recursive call to the MCP endpoint.
    if (!path.startsWith("/api/")) throw new Error("Invalid internal API path");
    const response = await app.inject({
      method,
      url: path,
      remoteAddress: request.ip,
      headers: { "x-api-key": mcpApiKey(request)!, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    recordMcpApiCall(request, method, path, response.statusCode);
    const result = response.json<ApiResponse<T>>();
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    if (response.statusCode >= 400) throw new Error("Internal API request failed");
    return result.data;
  }
  return {
    get: (path, query) => send("GET", query ? `${path}?${new URLSearchParams(query)}` : path),
    post: (path, body) => send("POST", path, body),
    patch: (path, body) => send("PATCH", path, body),
    delete: (path) => send("DELETE", path),
  };
}

export function createMcpTools(app: FastifyInstance) {
  // Schema discovery never executes a tool. Per-request closures below keep
  // credentials and execution failures isolated between concurrent clients.
  const unavailable = async (): Promise<never> => { throw new Error("No request context"); };
  const definitions = collectTools({ get: unavailable, post: unavailable, patch: unavailable, delete: unavailable });
  const ajv = new Ajv({ coerceTypes: false, useDefaults: false, removeAdditional: false });
  const tools = [...definitions.values()].map(({ tool, options }) => {
    const { server: _server, ...properties } = tool.parameters.properties ?? {};
    const readOnly = !options?.optional && READ_ONLY.has(tool.name);
    const inputSchema = {
      ...tool.parameters,
      properties,
      required: tool.parameters.required?.filter((key) => key !== "server") ?? [],
      additionalProperties: false,
    };
    return {
      name: tool.name,
      description: tool.description,
      inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly },
    };
  });
  const validators = new Map(tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));

  return {
    list: tools,
    has: (name: string) => definitions.has(name),
    async call(name: string, args: Record<string, unknown>, request: FastifyRequest) {
      const validate = validators.get(name)!;
      if (!validate(args)) {
        // Do not echo argument values, which may contain masked template data.
        return { isError: true, content: [{ type: "text", text: "Invalid tool arguments: check the input schema. Nothing was sent to the server." }] };
      }
      try {
        const toolsForRequest = collectTools(injectedClient(app, request));
        const result = await toolsForRequest.get(name)!.tool.execute(String(request.id), args);
        return { ...result, isError: isErrorResult(result) };
      } catch {
        return { isError: true, content: [{ type: "text", text: "Tool execution failed" }] };
      }
    },
  };
}
