import type { FastifyInstance } from "fastify";
import { execSync } from "child_process";
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

  // Start parity check
  app.post<{ Body?: { correct?: boolean } }>("/api/array/parity/start", {
    preHandler: requirePermission(Resource.ARRAY, Action.UPDATE),
    handler: async (req, reply) => {
      const correct = req.body?.correct ?? false;
      const mode = correct ? "CORRECT" : "NOCORRECT";
      try {
        execSync(`mdcmd check ${mode}`, { timeout: 10000 });
        return reply.send({ ok: true, data: { message: `Parity check started (${mode})` } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ ok: false, error: { code: "MDCMD_ERROR", message: msg } });
      }
    },
  });

  // Pause parity check
  app.post("/api/array/parity/pause", {
    preHandler: requirePermission(Resource.ARRAY, Action.UPDATE),
    handler: async (_req, reply) => {
      try {
        execSync("mdcmd nocheck PAUSE", { timeout: 10000 });
        return reply.send({ ok: true, data: { message: "Parity check paused" } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ ok: false, error: { code: "MDCMD_ERROR", message: msg } });
      }
    },
  });

  // Resume parity check
  app.post("/api/array/parity/resume", {
    preHandler: requirePermission(Resource.ARRAY, Action.UPDATE),
    handler: async (_req, reply) => {
      try {
        execSync("mdcmd check RESUME", { timeout: 10000 });
        return reply.send({ ok: true, data: { message: "Parity check resumed" } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ ok: false, error: { code: "MDCMD_ERROR", message: msg } });
      }
    },
  });

  // Cancel parity check
  app.post("/api/array/parity/cancel", {
    preHandler: requirePermission(Resource.ARRAY, Action.UPDATE),
    handler: async (_req, reply) => {
      try {
        execSync("mdcmd nocheck CANCEL", { timeout: 10000 });
        return reply.send({ ok: true, data: { message: "Parity check cancelled" } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ ok: false, error: { code: "MDCMD_ERROR", message: msg } });
      }
    },
  });

}
