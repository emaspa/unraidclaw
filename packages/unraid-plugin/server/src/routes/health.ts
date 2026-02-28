import type { FastifyInstance } from "fastify";
import type { GraphQLClient } from "../graphql-client.js";
import type { HealthResponse } from "@unraidclaw/shared";

const VERSION = "0.1.0";
const startTime = Date.now();

export function registerHealthRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  app.get<{ Reply: { ok: true; data: HealthResponse } }>("/api/health", async (_req, reply) => {
    const graphqlReachable = await gql.isReachable();

    return reply.send({
      ok: true,
      data: {
        status: graphqlReachable ? "ok" : "degraded",
        version: VERSION,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        graphqlReachable,
      },
    });
  });
}
