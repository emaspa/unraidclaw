import type { FastifyInstance } from "fastify";
import { execSync } from "child_process";
import { Resource, Action } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

function humanSize(kilobytes: number): string {
  if (kilobytes < 1024) return `${kilobytes} KiB`;
  const mib = kilobytes / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  const gib = mib / 1024;
  if (gib < 1024) return `${gib.toFixed(1)} GiB`;
  const tib = gib / 1024;
  return `${tib.toFixed(2)} TiB`;
}

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

const SET_STATE_MUTATION = `mutation ($input: ArrayStateInput!) {
  array {
    setState(input: $input) {
      state
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
      const data = await gql.query<{ array: Record<string, unknown> }>(STATUS_QUERY);
      const arr = data.array as Record<string, unknown>;
      // Add human-readable capacity
      const cap = arr.capacity as Record<string, unknown> | undefined;
      if (cap) {
        const kb = cap.kilobytes as Record<string, number> | undefined;
        if (kb) {
          (cap as Record<string, unknown>).human = {
            free: humanSize(kb.free),
            used: humanSize(kb.used),
            total: humanSize(kb.total),
          };
        }
      }
      // Add human-readable disk sizes
      const enrichDisks = (list: unknown[]) =>
        list.map((d) => {
          const disk = d as Record<string, unknown>;
          return typeof disk.size === "number"
            ? { ...disk, sizeHuman: humanSize(disk.size as number) }
            : disk;
        });
      if (Array.isArray(arr.disks)) arr.disks = enrichDisks(arr.disks);
      if (Array.isArray(arr.parities)) arr.parities = enrichDisks(arr.parities);
      return reply.send({ ok: true, data: arr });
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

  // Start array
  app.post("/api/array/start", {
    preHandler: requirePermission(Resource.ARRAY, Action.UPDATE),
    handler: async (_req, reply) => {
      const data = await gql.query<{ array: { setState: { state: string } } }>(
        SET_STATE_MUTATION,
        { input: { desiredState: "START" } },
      );
      return reply.send({ ok: true, data: data.array.setState });
    },
  });

  // Stop array
  app.post("/api/array/stop", {
    preHandler: requirePermission(Resource.ARRAY, Action.UPDATE),
    handler: async (_req, reply) => {
      const data = await gql.query<{ array: { setState: { state: string } } }>(
        SET_STATE_MUTATION,
        { input: { desiredState: "STOP" } },
      );
      return reply.send({ ok: true, data: data.array.setState });
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
