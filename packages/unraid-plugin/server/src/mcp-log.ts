import type { FastifyRequest } from "fastify";
import { routeActivity } from "./logger.js";

interface ApiCall {
  resource: string;
  action: string;
  statusCode: number;
}

interface McpActivity {
  method?: string;
  tool?: string;
  api?: ApiCall;
}

const KNOWN_METHODS = new Set(["initialize", "ping", "tools/list", "tools/call"]);
const activity = new WeakMap<FastifyRequest, McpActivity>();

function entry(request: FastifyRequest): McpActivity {
  let value = activity.get(request);
  if (!value) activity.set(request, value = {});
  return value;
}

/** Only fixed method names are logged, never a client-supplied string. */
export function recordMcpMethod(request: FastifyRequest, method: string): void {
  entry(request).method = KNOWN_METHODS.has(method) ? method
    : method.startsWith("notifications/") ? "notification" : "invalid";
}

/** Callers pass only names that exist in the tool registry. */
export function recordMcpTool(request: FastifyRequest, tool: string): void {
  entry(request).tool = tool;
}

export function recordMcpApiCall(request: FastifyRequest, method: string, url: string, statusCode: number): void {
  const value = entry(request);
  // Most tools make one call. When one makes several, keep the worst outcome so
  // a later success cannot hide a refusal.
  if (value.api && value.api.statusCode > statusCode) return;
  value.api = { ...routeActivity(method, url), statusCode };
}

// Every client connection sends these before its first tool call, and most
// clients also try GET for a stream they are refused. Logging them buried the
// tool calls, so only their failures are recorded.
const HANDSHAKE = new Set(["initialize", "ping", "tools/list", "notification"]);

/**
 * JSON-RPC reports tool failures inside an HTTP 200 response, so a tool call's
 * entry takes its resource, action and status from the API route it ran.
 * Returns null for a successful handshake request that is not logged.
 */
export function mcpActivity(request: FastifyRequest, statusCode: number) {
  const value = activity.get(request);
  if (statusCode === 405 && (request.method === "GET" || request.method === "DELETE")) return null;
  if (statusCode < 400 && !value?.tool && value?.method && HANDSHAKE.has(value.method)) return null;
  return {
    resource: value?.api?.resource ?? "mcp",
    action: value?.api?.action ?? value?.method ?? "rejected",
    statusCode: value?.api?.statusCode ?? statusCode,
    ...(value?.tool ? { tool: value.tool } : {}),
  };
}
