import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { ArrayStatus, ParityActionResponse } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

const STATUS_QUERY = `query {
  array {
    state
    capacity {
      kilobytes { free used total }
      disks { free used total }
    }
    disks {
      id
      name
      device
      size
      status
      temp
      fsType
      color
    }
    parityChecks {
      date
      duration
      speed
      status
      errors
    }
  }
}`;

const PARITY_STATUS_QUERY = `query {
  array {
    parityStatus {
      running
      progress
      speed
      errors
      elapsed
      estimated
    }
  }
}`;

function parityMutation(action: string): string {
  return `mutation {
    array {
      parity${action[0].toUpperCase() + action.slice(1)} {
        success
        message
      }
    }
  }`;
}

export function registerArrayRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  // Array status
  app.get("/api/array/status", {
    preHandler: requirePermission(Resource.ARRAY, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ array: ArrayStatus }>(STATUS_QUERY);
      return reply.send({ ok: true, data: data.array });
    },
  });

  // Parity status
  app.get("/api/array/parity/status", {
    preHandler: requirePermission(Resource.ARRAY, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ array: { parityStatus: unknown } }>(PARITY_STATUS_QUERY);
      return reply.send({ ok: true, data: data.array.parityStatus });
    },
  });

  // Parity actions: start, pause, resume, cancel
  for (const action of ["start", "pause", "resume", "cancel"] as const) {
    app.post(`/api/array/parity/${action}`, {
      preHandler: requirePermission(Resource.ARRAY, Action.UPDATE),
      handler: async (_req, reply) => {
        const mutationName = `parity${action[0].toUpperCase() + action.slice(1)}`;
        const data = await gql.query<{ array: Record<string, ParityActionResponse> }>(
          parityMutation(action)
        );
        return reply.send({ ok: true, data: data.array[mutationName] });
      },
    });
  }
}
