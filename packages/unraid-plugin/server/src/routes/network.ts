import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

// Unraid 7 GraphQL has no "network" root query.
// Return basic info from the info query instead.
const INFO_QUERY = `query {
  info {
    os {
      hostname
    }
  }
}`;

export function registerNetworkRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  app.get("/api/network", {
    preHandler: requirePermission(Resource.NETWORK, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ info: { os: { hostname: string } } }>(INFO_QUERY);
      return reply.send({
        ok: true,
        data: {
          hostname: data.info.os.hostname,
          note: "Full network info not available via Unraid GraphQL API",
        },
      });
    },
  });
}
