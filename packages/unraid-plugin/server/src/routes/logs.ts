import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { LogsResponse } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

const SYSLOG_QUERY = `query ($limit: Int, $offset: Int) {
  logs {
    syslog(limit: $limit, offset: $offset) {
      entries {
        timestamp
        facility
        severity
        message
      }
      total
    }
  }
}`;

export function registerLogRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  app.get<{ Querystring: { limit?: string; offset?: string } }>("/api/logs/syslog", {
    preHandler: requirePermission(Resource.LOGS, Action.READ),
    handler: async (req, reply) => {
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
      const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
      const data = await gql.query<{ logs: { syslog: LogsResponse } }>(
        SYSLOG_QUERY,
        { limit, offset }
      );
      return reply.send({ ok: true, data: data.logs.syslog });
    },
  });
}
