import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

const LIST_QUERY = `query {
  shares {
    name
    comment
    allocator
    floor
    splitLevel
    cache
    free
    size
  }
}`;

export function registerShareRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  // List shares
  app.get("/api/shares", {
    preHandler: requirePermission(Resource.SHARE, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ shares: unknown[] }>(LIST_QUERY);
      return reply.send({ ok: true, data: data.shares });
    },
  });

  // Get share by name (filter from list — no singular share query in Unraid 7)
  app.get<{ Params: { name: string } }>("/api/shares/:name", {
    preHandler: requirePermission(Resource.SHARE, Action.READ),
    handler: async (req, reply) => {
      const data = await gql.query<{ shares: Array<{ name: string }> }>(LIST_QUERY);
      const share = data.shares.find(
        (s) => s.name.toLowerCase() === req.params.name.toLowerCase()
      );
      if (!share) {
        return reply.code(404).send({
          ok: false,
          error: { code: "NOT_FOUND", message: `Share '${req.params.name}' not found` },
        });
      }
      return reply.send({ ok: true, data: share });
    },
  });
}
