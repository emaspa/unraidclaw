import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { VM, VMActionResponse } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

const LIST_QUERY = `query {
  vms {
    domains {
      id
      name
      state
      uuid
      coreCount
      ramAllocation
      primaryGPU
      description
      autoStart
    }
  }
}`;

const DETAIL_QUERY = `query ($id: String!) {
  vms {
    domain(id: $id) {
      id
      name
      state
      uuid
      coreCount
      ramAllocation
      primaryGPU
      description
      autoStart
    }
  }
}`;

function vmMutation(action: string): string {
  return `mutation ($id: String!) {
    vms {
      ${action}(id: $id) {
        id
        name
        state
        uuid
      }
    }
  }`;
}

export function registerVMRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  // List VMs
  app.get("/api/vms", {
    preHandler: requirePermission(Resource.VMS, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ vms: { domains: VM[] } }>(LIST_QUERY);
      return reply.send({ ok: true, data: data.vms.domains });
    },
  });

  // Get VM details
  app.get<{ Params: { id: string } }>("/api/vms/:id", {
    preHandler: requirePermission(Resource.VMS, Action.READ),
    handler: async (req, reply) => {
      const data = await gql.query<{ vms: { domain: VM } }>(DETAIL_QUERY, { id: req.params.id });
      return reply.send({ ok: true, data: data.vms.domain });
    },
  });

  // VM actions: start, stop, pause, resume, force-stop, reboot, reset
  const actionMap: Record<string, { mutation: string; permission: Action }> = {
    start: { mutation: "start", permission: Action.UPDATE },
    stop: { mutation: "stop", permission: Action.UPDATE },
    pause: { mutation: "pause", permission: Action.UPDATE },
    resume: { mutation: "resume", permission: Action.UPDATE },
    "force-stop": { mutation: "forceStop", permission: Action.UPDATE },
    reboot: { mutation: "reboot", permission: Action.UPDATE },
    reset: { mutation: "reset", permission: Action.UPDATE },
  };

  for (const [path, { mutation, permission }] of Object.entries(actionMap)) {
    app.post<{ Params: { id: string } }>(`/api/vms/:id/${path}`, {
      preHandler: requirePermission(Resource.VMS, permission),
      handler: async (req, reply) => {
        const data = await gql.query<{ vms: Record<string, VMActionResponse> }>(
          vmMutation(mutation),
          { id: req.params.id }
        );
        return reply.send({ ok: true, data: data.vms[mutation] });
      },
    });
  }

  // Remove VM (destructive)
  app.delete<{ Params: { id: string } }>("/api/vms/:id", {
    preHandler: requirePermission(Resource.VMS, Action.DELETE),
    handler: async (req, reply) => {
      const data = await gql.query<{ vms: { remove: VMActionResponse } }>(
        vmMutation("remove"),
        { id: req.params.id }
      );
      return reply.send({ ok: true, data: data.vms.remove });
    },
  });
}
