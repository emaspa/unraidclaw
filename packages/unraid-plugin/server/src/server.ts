import Fastify from "fastify";
import type { ServerConfig } from "./config.js";
import { createAuthHook } from "./auth.js";
import { GraphQLClient, GraphQLError } from "./graphql-client.js";
import { ActivityLogger, type ActivityLogEntry } from "./logger.js";

import { registerHealthRoutes } from "./routes/health.js";
import { registerDockerRoutes } from "./routes/docker.js";
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

  // CORS for WebGUI interaction
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type, x-api-key");
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
    const resource = parts[0] ?? "unknown";
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
  registerVMRoutes(app, gql);
  registerArrayRoutes(app, gql);
  registerDiskRoutes(app, gql);
  registerShareRoutes(app, gql);
  registerSystemRoutes(app, gql);
  registerNotificationRoutes(app, gql);
  registerNetworkRoutes(app, gql);
  registerUserRoutes(app, gql);
  registerLogRoutes(app, gql);

  return app;
}
