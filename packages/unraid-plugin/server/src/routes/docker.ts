import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { DockerContainer, DockerContainerDetail, DockerActionResponse, DockerLogsResponse } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

const LIST_QUERY = `query {
  docker {
    containers {
      id
      names
      image
      state
      status
      autoStart
    }
  }
}`;

const DETAIL_QUERY = `query ($id: String!) {
  docker {
    container(id: $id) {
      id
      names
      image
      state
      status
      autoStart
      ports { ip privatePort publicPort type }
      mounts { source destination mode }
      networkMode
    }
  }
}`;

const LOGS_QUERY = `query ($id: String!, $tail: Int, $since: String) {
  docker {
    containerLogs(id: $id, tail: $tail, since: $since)
  }
}`;

function actionMutation(action: string): string {
  return `mutation ($id: String!) {
    docker {
      ${action}(id: $id) {
        id
        names
        state
        status
      }
    }
  }`;
}

export function registerDockerRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  // List containers
  app.get("/api/docker/containers", {
    preHandler: requirePermission(Resource.DOCKER, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ docker: { containers: DockerContainer[] } }>(LIST_QUERY);
      return reply.send({ ok: true, data: data.docker.containers });
    },
  });

  // Get container details
  app.get<{ Params: { id: string } }>("/api/docker/containers/:id", {
    preHandler: requirePermission(Resource.DOCKER, Action.READ),
    handler: async (req, reply) => {
      const data = await gql.query<{ docker: { container: DockerContainerDetail } }>(
        DETAIL_QUERY,
        { id: req.params.id }
      );
      return reply.send({ ok: true, data: data.docker.container });
    },
  });

  // Get container logs
  app.get<{ Params: { id: string }; Querystring: { tail?: string; since?: string } }>(
    "/api/docker/containers/:id/logs",
    {
      preHandler: requirePermission(Resource.DOCKER, Action.READ),
      handler: async (req, reply) => {
        const tail = req.query.tail ? parseInt(req.query.tail, 10) : 100;
        const data = await gql.query<{ docker: { containerLogs: string } }>(
          LOGS_QUERY,
          { id: req.params.id, tail, since: req.query.since ?? null }
        );
        const response: DockerLogsResponse = { id: req.params.id, logs: data.docker.containerLogs };
        return reply.send({ ok: true, data: response });
      },
    }
  );

  // Container actions: start, stop, restart, pause, unpause
  for (const action of ["start", "stop", "restart", "pause", "unpause"] as const) {
    app.post<{ Params: { id: string } }>(`/api/docker/containers/:id/${action}`, {
      preHandler: requirePermission(Resource.DOCKER, Action.UPDATE),
      handler: async (req, reply) => {
        const data = await gql.query<{ docker: Record<string, DockerActionResponse> }>(
          actionMutation(action),
          { id: req.params.id }
        );
        return reply.send({ ok: true, data: data.docker[action] });
      },
    });
  }

  // Remove container (destructive)
  app.delete<{ Params: { id: string } }>("/api/docker/containers/:id", {
    preHandler: requirePermission(Resource.DOCKER, Action.DELETE),
    handler: async (req, reply) => {
      const data = await gql.query<{ docker: { remove: DockerActionResponse } }>(
        actionMutation("remove"),
        { id: req.params.id }
      );
      return reply.send({ ok: true, data: data.docker.remove });
    },
  });
}
