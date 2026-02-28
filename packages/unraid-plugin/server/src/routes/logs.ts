import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

// Unraid 7 GraphQL has no "logs" root query.
// Return a message indicating this endpoint is not available.

export function registerLogRoutes(app: FastifyInstance, _gql: GraphQLClient): void {
  app.get("/api/logs/syslog", {
    preHandler: requirePermission(Resource.LOGS, Action.READ),
    handler: async (_req, reply) => {
      return reply.send({
        ok: true,
        data: {
          entries: [],
          total: 0,
          note: "Syslog not available via Unraid GraphQL API",
        },
      });
    },
  });
}
