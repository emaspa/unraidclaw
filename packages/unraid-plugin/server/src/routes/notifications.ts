import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { Notification, CreateNotificationRequest } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

const LIST_QUERY = `query {
  notifications {
    id
    title
    subject
    description
    importance
    type
    timestamp
    archived
  }
}`;

const CREATE_MUTATION = `mutation ($input: CreateNotificationInput!) {
  createNotification(input: $input) {
    id
    title
    subject
  }
}`;

const ARCHIVE_MUTATION = `mutation ($id: String!) {
  archiveNotification(id: $id) {
    id
    archived
  }
}`;

const DELETE_MUTATION = `mutation ($id: String!) {
  deleteNotification(id: $id) {
    success
    message
  }
}`;

export function registerNotificationRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  // List notifications
  app.get("/api/notifications", {
    preHandler: requirePermission(Resource.NOTIFICATION, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ notifications: Notification[] }>(LIST_QUERY);
      return reply.send({ ok: true, data: data.notifications });
    },
  });

  // Create notification
  app.post<{ Body: CreateNotificationRequest }>("/api/notifications", {
    preHandler: requirePermission(Resource.NOTIFICATION, Action.CREATE),
    handler: async (req, reply) => {
      const data = await gql.query<{ createNotification: { id: string } }>(
        CREATE_MUTATION,
        { input: req.body }
      );
      return reply.code(201).send({ ok: true, data: data.createNotification });
    },
  });

  // Archive notification
  app.post<{ Params: { id: string } }>("/api/notifications/:id/archive", {
    preHandler: requirePermission(Resource.NOTIFICATION, Action.UPDATE),
    handler: async (req, reply) => {
      const data = await gql.query<{ archiveNotification: { id: string; archived: boolean } }>(
        ARCHIVE_MUTATION,
        { id: req.params.id }
      );
      return reply.send({ ok: true, data: data.archiveNotification });
    },
  });

  // Delete notification
  app.delete<{ Params: { id: string } }>("/api/notifications/:id", {
    preHandler: requirePermission(Resource.NOTIFICATION, Action.DELETE),
    handler: async (req, reply) => {
      const data = await gql.query<{ deleteNotification: { success: boolean } }>(
        DELETE_MUTATION,
        { id: req.params.id }
      );
      return reply.send({ ok: true, data: data.deleteNotification });
    },
  });
}
