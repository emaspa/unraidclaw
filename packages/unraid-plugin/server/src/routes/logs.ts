import type { FastifyInstance } from "fastify";
import { execSync } from "child_process";
import { Resource, Action } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

export function registerLogRoutes(app: FastifyInstance, _gql: GraphQLClient): void {
  app.get<{ Querystring: { lines?: string } }>("/api/logs/syslog", {
    preHandler: requirePermission(Resource.LOGS, Action.READ),
    handler: async (req, reply) => {
      const lines = Math.min(Math.max(parseInt(req.query.lines || "50", 10) || 50, 1), 1000);
      try {
        const output = execSync(`tail -n ${lines} /var/log/syslog`, { timeout: 5000, encoding: "utf-8" });
        const entries = output.trim().split("\n").filter(Boolean);
        return reply.send({ ok: true, data: { entries, total: entries.length } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ ok: false, error: { code: "SYSLOG_ERROR", message: msg } });
      }
    },
  });
}
