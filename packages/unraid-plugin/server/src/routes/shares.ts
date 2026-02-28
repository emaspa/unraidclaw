import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { Share, CreateShareRequest, UpdateShareRequest } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

const LIST_QUERY = `query {
  shares {
    name
    comment
    allocator
    floor
    splitLevel
    include
    exclude
    useCache
    free
    used
    size
  }
}`;

const DETAIL_QUERY = `query ($name: String!) {
  share(name: $name) {
    name
    comment
    allocator
    floor
    splitLevel
    include
    exclude
    useCache
    free
    used
    size
  }
}`;

const CREATE_MUTATION = `mutation ($input: CreateShareInput!) {
  createShare(input: $input) {
    name
    comment
  }
}`;

const UPDATE_MUTATION = `mutation ($name: String!, $input: UpdateShareInput!) {
  updateShare(name: $name, input: $input) {
    name
    comment
  }
}`;

const DELETE_MUTATION = `mutation ($name: String!) {
  deleteShare(name: $name) {
    success
    message
  }
}`;

export function registerShareRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  // List shares
  app.get("/api/shares", {
    preHandler: requirePermission(Resource.SHARE, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ shares: Share[] }>(LIST_QUERY);
      return reply.send({ ok: true, data: data.shares });
    },
  });

  // Get share details
  app.get<{ Params: { name: string } }>("/api/shares/:name", {
    preHandler: requirePermission(Resource.SHARE, Action.READ),
    handler: async (req, reply) => {
      const data = await gql.query<{ share: Share }>(DETAIL_QUERY, { name: req.params.name });
      return reply.send({ ok: true, data: data.share });
    },
  });

  // Create share
  app.post<{ Body: CreateShareRequest }>("/api/shares", {
    preHandler: requirePermission(Resource.SHARE, Action.CREATE),
    handler: async (req, reply) => {
      const data = await gql.query<{ createShare: { name: string; comment: string } }>(
        CREATE_MUTATION,
        { input: req.body }
      );
      return reply.code(201).send({ ok: true, data: data.createShare });
    },
  });

  // Update share
  app.patch<{ Params: { name: string }; Body: UpdateShareRequest }>("/api/shares/:name", {
    preHandler: requirePermission(Resource.SHARE, Action.UPDATE),
    handler: async (req, reply) => {
      const data = await gql.query<{ updateShare: { name: string; comment: string } }>(
        UPDATE_MUTATION,
        { name: req.params.name, input: req.body }
      );
      return reply.send({ ok: true, data: data.updateShare });
    },
  });

  // Delete share
  app.delete<{ Params: { name: string } }>("/api/shares/:name", {
    preHandler: requirePermission(Resource.SHARE, Action.DELETE),
    handler: async (req, reply) => {
      const data = await gql.query<{ deleteShare: { success: boolean; message: string } }>(
        DELETE_MUTATION,
        { name: req.params.name }
      );
      return reply.send({ ok: true, data: data.deleteShare });
    },
  });
}
