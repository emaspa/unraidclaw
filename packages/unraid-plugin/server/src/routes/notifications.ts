import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

const LIST_QUERY = `query ($type: NotificationType!, $offset: Int!, $limit: Int!) {
  notifications {
    list(filter: { type: $type, offset: $offset, limit: $limit }) {
      id
      subject
      description
      importance
      timestamp
      type
    }
  }
}`;

const OVERVIEW_QUERY = `query {
  notifications {
    overview {
      unread {
        total
        warning
        alert
      }
    }
  }
}`;

export function registerNotificationRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  // List notifications
  app.get<{ Querystring: { type?: string; limit?: string; offset?: string } }>("/api/notifications", {
    preHandler: requirePermission(Resource.NOTIFICATION, Action.READ),
    handler: async (req, reply) => {
      const type = (req.query.type || "UNREAD").toUpperCase();
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
      const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
      const data = await gql.query<{ notifications: { list: unknown[] } }>(
        LIST_QUERY,
        { type, offset, limit }
      );
      return reply.send({ ok: true, data: data.notifications.list });
    },
  });

  // Notification overview/counts
  app.get("/api/notifications/overview", {
    preHandler: requirePermission(Resource.NOTIFICATION, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ notifications: { overview: unknown } }>(OVERVIEW_QUERY);
      return reply.send({ ok: true, data: data.notifications.overview });
    },
  });
}
