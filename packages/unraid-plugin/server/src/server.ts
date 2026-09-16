import Fastify from "fastify";
import type { ServerConfig } from "./config.js";
import { createAuthHook } from "./auth.js";
import { GraphQLClient, GraphQLError } from "./graphql-client.js";
import { ActivityLogger, type ActivityLogEntry } from "./logger.js";
import { isMcpPath, mcpOrigins, validMcpOrigin } from "./mcp-security.js";
import { registerMcpRoutes } from "./routes/mcp.js";

import { registerHealthRoutes } from "./routes/health.js";
import { registerDockerRoutes } from "./routes/docker.js";
import { registerCaRoutes } from "./routes/ca.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerVMRoutes } from "./routes/vms.js";
import { registerArrayRoutes } from "./routes/array.js";
import { registerDiskRoutes } from "./routes/disks.js";
import { registerShareRoutes } from "./routes/shares.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerNetworkRoutes } from "./routes/network.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerLogRoutes } from "./routes/logs.js";

export function createServer(config: ServerConfig, httpsOpts?: { cert: Buffer; key: Buffer }) {
  const app = Fastify({ logger: true, ...(httpsOpts ? { https: httpsOpts } : {}) });
  const gql = new GraphQLClient(config);
  const activityLogger = new ActivityLogger(config);
  const allowedMcpOrigins = config.mcpEnabled ? mcpOrigins(config, !!httpsOpts) : new Set<string>();

  app.addHook("onRequest", async (request, reply) => {
    if (!isMcpPath(request.url)) return;
    if (!config.mcpEnabled) return reply.callNotFound();
    if (!validMcpOrigin(request.headers.origin, allowedMcpOrigins)) {
      return reply.code(403).send({ ok: false, error: { code: "FORBIDDEN", message: "Origin not allowed" } });
    }
  });

  // CORS - only allow same-origin and local requests
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin) {
      try {
        const url = new URL(origin);
        const host = url.hostname;
        if (isMcpPath(request.url) ? allowedMcpOrigins.has(origin) : (
          host === "localhost" ||
          host === "127.0.0.1" ||
          host === "::1" ||
          host.startsWith("192.168.") ||
          host.startsWith("10.") ||
          host.startsWith("172.") ||
          host.endsWith(".local")
        )) {
          reply.header("Access-Control-Allow-Origin", origin);
          reply.header("Vary", "Origin");
        }
      } catch {
        // Invalid origin, skip CORS headers
      }
    }
    reply.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    reply.header("Access-Control-Allow-Headers", isMcpPath(request.url)
      ? "Content-Type, x-api-key, Authorization, MCP-Protocol-Version"
      : "Content-Type, x-api-key");
    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  // Auth hook
  app.addHook("onRequest", createAuthHook(config));

  // Activity logging hook
  app.addHook("onResponse", async (request, reply) => {
    if (request.url === "/api/health") return;
    // Extract resource:action from route URL
    const parts = request.url.replace("/api/", "").split("/");
    const resource = isMcpPath(request.url) ? "mcp" : parts[0] ?? "unknown";
    const action = request.method === "GET" ? "read" : request.method === "DELETE" ? "delete" : "update";

    const entry: ActivityLogEntry = {
      timestamp: new Date().toISOString(),
      method: request.method,
      path: request.url,
      resource,
      action,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
      ip: request.ip,
    };
    activityLogger.log(entry);
  });

  // Error handler
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof GraphQLError) {
      return reply.code(error.statusCode >= 500 ? 502 : error.statusCode).send({
        ok: false,
        error: { code: "GRAPHQL_ERROR", message: error.message },
      });
    }

    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    const statusCode = fastifyError.statusCode ?? 500;
    return reply.code(statusCode).send({
      ok: false,
      error: {
        code: fastifyError.code ?? "INTERNAL_ERROR",
        message: statusCode >= 500 ? "Internal server error" : (fastifyError.message ?? "Unknown error"),
      },
    });
  });

  // Register routes
  registerHealthRoutes(app, gql);
  registerDockerRoutes(app, gql);
  registerCaRoutes(app);
  registerPluginRoutes(app);
  registerVMRoutes(app, gql);
  registerArrayRoutes(app, gql);
  registerDiskRoutes(app, gql);
  registerShareRoutes(app, gql);
  registerSystemRoutes(app, gql);
  registerNotificationRoutes(app, gql);
  registerNetworkRoutes(app, gql);
  registerUserRoutes(app, gql);
  registerLogRoutes(app, gql);
  if (config.mcpEnabled) app.register(registerMcpRoutes);

  return app;
}
