import type { FastifyInstance } from "fastify";
import { execSync } from "child_process";
import { existsSync, unlinkSync, renameSync, mkdirSync } from "fs";
import { Resource, Action } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

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

  // Create notification via Unraid notify script
  app.post<{ Body: { title: string; subject: string; description: string; importance?: string } }>("/api/notifications", {
    preHandler: requirePermission(Resource.NOTIFICATION, Action.CREATE),
    handler: async (req, reply) => {
      const { title, subject, description, importance } = req.body;
      if (!title || !subject || !description) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "title, subject, and description are required" } });
      }
      const level = importance || "normal";
      try {
        execSync(
          `/usr/local/emhttp/webGui/scripts/notify -e ${shellEscape(title)} -s ${shellEscape(subject)} -d ${shellEscape(description)} -i ${shellEscape(level)}`,
          { timeout: 10000 },
        );
        return reply.send({ ok: true, data: { message: "Notification created" } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ ok: false, error: { code: "NOTIFY_ERROR", message: msg } });
      }
    },
  });

  // Archive notification (move from unread to archive)
  app.post<{ Params: { id: string } }>("/api/notifications/:id/archive", {
    preHandler: requirePermission(Resource.NOTIFICATION, Action.UPDATE),
    handler: async (req, reply) => {
      const { id } = req.params;
      const src = `/tmp/notifications/unread/${id}`;
      const dst = `/tmp/notifications/archive/${id}`;
      if (!existsSync(src)) {
        return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: `Notification ${id} not found in unread` } });
      }
      try {
        mkdirSync("/tmp/notifications/archive", { recursive: true });
        renameSync(src, dst);
        return reply.send({ ok: true, data: { message: `Notification ${id} archived` } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ ok: false, error: { code: "ARCHIVE_ERROR", message: msg } });
      }
    },
  });

  // Delete notification
  app.delete<{ Params: { id: string } }>("/api/notifications/:id", {
    preHandler: requirePermission(Resource.NOTIFICATION, Action.DELETE),
    handler: async (req, reply) => {
      const { id } = req.params;
      const unread = `/tmp/notifications/unread/${id}`;
      const archive = `/tmp/notifications/archive/${id}`;
      const target = existsSync(unread) ? unread : existsSync(archive) ? archive : null;
      if (!target) {
        return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: `Notification ${id} not found` } });
      }
      try {
        unlinkSync(target);
        return reply.send({ ok: true, data: { message: `Notification ${id} deleted` } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ ok: false, error: { code: "DELETE_ERROR", message: msg } });
      }
    },
  });
}
