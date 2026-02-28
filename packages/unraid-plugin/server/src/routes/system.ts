import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { SystemInfo, SystemMetrics, ServiceInfo } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

const INFO_QUERY = `query {
  info {
    os {
      platform
      hostname
      uptime
      version
    }
    cpu {
      model
      cores
      threads
      frequency
    }
    memory {
      total
      used
      free
      cached
    }
    versions {
      unraid
      kernel
    }
  }
}`;

const METRICS_QUERY = `query {
  info {
    cpu { usage loadAverage }
    memory { totalBytes usedBytes freeBytes usagePercent }
    uptime
  }
}`;

const SERVICES_QUERY = `query {
  services {
    name
    state
    autoStart
  }
}`;

export function registerSystemRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  // System info
  app.get("/api/system/info", {
    preHandler: requirePermission(Resource.INFO, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ info: SystemInfo }>(INFO_QUERY);
      return reply.send({ ok: true, data: data.info });
    },
  });

  // System metrics (live)
  app.get("/api/system/metrics", {
    preHandler: requirePermission(Resource.INFO, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ info: SystemMetrics }>(METRICS_QUERY);
      return reply.send({ ok: true, data: data.info });
    },
  });

  // List services
  app.get("/api/system/services", {
    preHandler: requirePermission(Resource.SERVICES, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ services: ServiceInfo[] }>(SERVICES_QUERY);
      return reply.send({ ok: true, data: data.services });
    },
  });

  // Reboot
  app.post("/api/system/reboot", {
    preHandler: requirePermission(Resource.OS, Action.UPDATE),
    handler: async (_req, reply) => {
      await gql.query(`mutation { reboot { success message } }`);
      return reply.send({ ok: true, data: { message: "Reboot initiated" } });
    },
  });

  // Shutdown
  app.post("/api/system/shutdown", {
    preHandler: requirePermission(Resource.OS, Action.UPDATE),
    handler: async (_req, reply) => {
      await gql.query(`mutation { shutdown { success message } }`);
      return reply.send({ ok: true, data: { message: "Shutdown initiated" } });
    },
  });
}
