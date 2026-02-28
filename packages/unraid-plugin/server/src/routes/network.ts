import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { NetworkInfo } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

const INFO_QUERY = `query {
  network {
    hostname
    domain
    gateway
    dns
    interfaces {
      name
      ipAddress
      ipv6Address
      macAddress
      speed
      status
      mtu
    }
  }
}`;

export function registerNetworkRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  app.get("/api/network", {
    preHandler: requirePermission(Resource.NETWORK, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ network: NetworkInfo }>(INFO_QUERY);
      return reply.send({ ok: true, data: data.network });
    },
  });
}
