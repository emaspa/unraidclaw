import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

const STATUS_QUERY = `query {
  array {
    state
    capacity {
      kilobytes { free used total }
    }
    disks {
      name
      device
      size
      status
      temp
      fsType
      color
    }
    parities {
      name
      device
      size
      status
      numErrors
    }
  }
}`;

const PARITY_STATUS_QUERY = `query {
  array {
    parityCheckStatus {
      running
      progress
      speed
      errors
    }
  }
}`;

export function registerArrayRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  // Array status
  app.get("/api/array/status", {
    preHandler: requirePermission(Resource.ARRAY, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ array: unknown }>(STATUS_QUERY);
      return reply.send({ ok: true, data: data.array });
    },
  });

  // Parity status
  app.get("/api/array/parity/status", {
    preHandler: requirePermission(Resource.ARRAY, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ array: { parityCheckStatus: unknown } }>(PARITY_STATUS_QUERY);
      return reply.send({ ok: true, data: data.array.parityCheckStatus });
    },
  });

}
