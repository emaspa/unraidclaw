import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { DiskInfo } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

const LIST_QUERY = `query {
  disks {
    id
    name
    device
    size
    temp
    status
    fsType
  }
}`;

const DETAIL_QUERY = `query ($id: String!) {
  disk(id: $id) {
    id
    name
    device
    size
    temp
    status
    fsType
    smart {
      health
      temperature
      powerOnHours
      attributes {
        id
        name
        value
        worst
        threshold
        raw
      }
    }
  }
}`;

export function registerDiskRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  // List disks
  app.get("/api/disks", {
    preHandler: requirePermission(Resource.DISK, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ disks: DiskInfo[] }>(LIST_QUERY);
      return reply.send({ ok: true, data: data.disks });
    },
  });

  // Disk details with SMART data
  app.get<{ Params: { id: string } }>("/api/disks/:id", {
    preHandler: requirePermission(Resource.DISK, Action.READ),
    handler: async (req, reply) => {
      const data = await gql.query<{ disk: DiskInfo }>(DETAIL_QUERY, { id: req.params.id });
      return reply.send({ ok: true, data: data.disk });
    },
  });
}
