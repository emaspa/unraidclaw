import type { FastifyInstance } from "fastify";
import { execSync } from "child_process";
import { Resource, Action } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

const INFO_QUERY = `query {
  info {
    os {
      platform
      hostname
      uptime
    }
    cpu {
      model
      cores
      threads
    }
    memory {
      __typename
    }
  }
}`;

const SERVICES_QUERY = `query {
  services {
    name
    id
    online
  }
}`;

export function registerSystemRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  // System info
  app.get("/api/system/info", {
    preHandler: requirePermission(Resource.INFO, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ info: unknown }>(INFO_QUERY);
      return reply.send({ ok: true, data: data.info });
    },
  });

  // System metrics (same as info — Unraid 7 doesn't have separate metrics query)
  app.get("/api/system/metrics", {
    preHandler: requirePermission(Resource.INFO, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ info: unknown }>(INFO_QUERY);
      return reply.send({ ok: true, data: data.info });
    },
  });

  // List services
  app.get("/api/system/services", {
    preHandler: requirePermission(Resource.SERVICES, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ services: unknown[] }>(SERVICES_QUERY);
      return reply.send({ ok: true, data: data.services });
    },
  });

  // Reboot
  app.post("/api/system/reboot", {
    preHandler: requirePermission(Resource.OS, Action.UPDATE),
    handler: async (_req, reply) => {
      try {
        // Send response before rebooting
        reply.send({ ok: true, data: { message: "Reboot initiated" } });
        execSync("nohup /sbin/reboot &", { timeout: 5000 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ ok: false, error: { code: "REBOOT_ERROR", message: msg } });
      }
    },
  });

  // Shutdown
  app.post("/api/system/shutdown", {
    preHandler: requirePermission(Resource.OS, Action.UPDATE),
    handler: async (_req, reply) => {
      try {
        reply.send({ ok: true, data: { message: "Shutdown initiated" } });
        execSync("nohup /sbin/poweroff &", { timeout: 5000 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ ok: false, error: { code: "SHUTDOWN_ERROR", message: msg } });
      }
    },
  });
}
