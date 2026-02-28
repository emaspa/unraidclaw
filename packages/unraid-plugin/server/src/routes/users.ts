import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { UserInfo } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

const ME_QUERY = `query {
  me {
    name
    description
    role
  }
}`;

export function registerUserRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  app.get("/api/users/me", {
    preHandler: requirePermission(Resource.ME, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ me: UserInfo }>(ME_QUERY);
      return reply.send({ ok: true, data: data.me });
    },
  });
}
