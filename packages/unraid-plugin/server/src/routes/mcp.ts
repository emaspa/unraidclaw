import type { FastifyInstance } from "fastify";
import { recordMcpMethod, recordMcpTool } from "../mcp-log.js";
import { createMcpTools } from "../mcp-tools.js";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const MCP_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function error(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  const tools = createMcpTools(app);

  // Encapsulated parsing keeps REST JSON parsing and error envelopes unchanged.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));
  app.setErrorHandler(async (err, _request, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send(error(null, status >= 500 ? -32603 : -32600,
      status >= 500 ? "Internal error" : "Invalid request"));
  });

  app.route({
    method: ["GET", "DELETE"], url: "/mcp",
    handler: async (_request, reply) => reply.header("Allow", "POST").code(405).send(),
  });

  app.post("/mcp", async (request, reply) => {
    if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return reply.code(415).send(error(null, -32600, "Content-Type must be application/json"));
    }
    const accept = request.headers.accept;
    if (accept && !accept.split(",").some((entry) => ["application/json", "application/*", "*/*"].includes(entry.split(";", 1)[0].trim()))) {
      return reply.code(406).send(error(null, -32600, "Accept must allow application/json"));
    }
    let message: unknown;
    try {
      message = JSON.parse(request.body as string);
    } catch {
      return reply.code(400).send(error(null, -32700, "Parse error"));
    }
    // MCP 2025-03-26 allowed batches, but later revisions removed them. This
    // subset rejects batches for every version. Null IDs and response messages
    // are also refused: this server never sends requests that need a response.
    if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string"
      || "result" in message || "error" in message
      || ("id" in message && typeof message.id !== "string" && !(typeof message.id === "number" && Number.isSafeInteger(message.id)))) {
      return reply.code(400).send(error(null, -32600, "Invalid request"));
    }
    recordMcpMethod(request, message.method);
    const id = (message.id ?? null) as string | number | null;
    const fail = (code: number, text: string) => reply.code(400).send(error(id, code, text));
    if (message.params !== undefined && !object(message.params)) return fail(-32602, "Invalid params");
    const params = (message.params ?? {}) as Record<string, unknown>;

    // A stateless server uses the transport's 2025-03-26 fallback when the
    // version header is absent. This JSON-only subset supports all three versions.
    const version = request.headers["mcp-protocol-version"] ?? "2025-03-26";
    if (typeof version !== "string" || !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      return fail(-32600, `MCP-Protocol-Version must be one of: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`);
    }
    if (!("id" in message)) {
      if (!message.method.startsWith("notifications/")) return fail(-32600, "Invalid notification");
      return reply.code(202).send();
    }
    const result = (value: unknown) => reply.send({ jsonrpc: "2.0", id, result: value });
    switch (message.method) {
      case "initialize":
        if (typeof params.protocolVersion !== "string" || !object(params.capabilities)
          || !object(params.clientInfo) || typeof params.clientInfo.name !== "string"
          || typeof params.clientInfo.version !== "string") return fail(-32602, "Invalid initialize params");
        return result({
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "unraidclaw", version: process.env.OCC_VERSION || "dev" },
        });
      case "ping":
        return result({});
      case "tools/list":
        if (params.cursor !== undefined) return fail(-32602, "Invalid cursor: tools are returned in one page");
        return result({ tools: tools.list });
      case "tools/call":
        if (typeof params.name !== "string" || (params.arguments !== undefined && !object(params.arguments))) {
          return fail(-32602, "Invalid tools/call params");
        }
        if (!tools.has(params.name)) return fail(-32602, "Unknown tool");
        recordMcpTool(request, params.name);
        return result(await tools.call(params.name, (params.arguments ?? {}) as Record<string, unknown>, request));
      default:
        return fail(-32601, "Method not found");
    }
  });
}
