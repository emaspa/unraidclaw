import type { FastifyInstance } from "fastify";
import type { GraphQLClient } from "../graphql-client.js";
import type { HealthResponse } from "@unraidclaw/shared";

const VERSION = process.env.OCC_VERSION || "dev";
const startTime = Date.now();

export function registerHealthRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  app.get<{ Reply: { ok: true; data: HealthResponse } }>("/api/health", async (_req, reply) => {
    const unraidApiKeyConfigured = gql.hasApiKey;
    const { reachable: graphqlReachable, message } = await gql.check();

    return reply.send({
      ok: true,
      data: {
        status: graphqlReachable && !message ? "ok" : "degraded",
        version: VERSION,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        graphqlReachable,
        unraidApiKeyConfigured,
        ...(message ? { message } : {}),
      },
    });
  });
}
