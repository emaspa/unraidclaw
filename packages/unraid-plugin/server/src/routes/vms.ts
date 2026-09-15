import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { VM } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LIST_QUERY = `query {
  vms {
    domains {
      id
      name
      state
    }
  }
}`;

/**
 * The API deprecated `uuid` in favor of `id`, which it returns prefixed with the
 * server identifier (`<serverId>:<uuid>`). Responses keep their `uuid` field.
 */
function withUuid(d: VM): VM {
  return { ...d, uuid: d.id.slice(d.id.lastIndexOf(":") + 1) };
}

const VIRSH_ACTION_MAP: Record<string, string> = {
  start: "start",
  stop: "shutdown",
  "force-stop": "destroy",
  pause: "suspend",
  resume: "resume",
  reboot: "reboot",
  reset: "reset",
};

export function registerVMRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  // List VMs
  app.get("/api/vms", {
    preHandler: requirePermission(Resource.VMS, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ vms: { domains: VM[] } }>(LIST_QUERY);
      return reply.send({ ok: true, data: data.vms.domains.map(withUuid) });
    },
  });

  // Get VM details (filter from list)
  app.get<{ Params: { id: string } }>("/api/vms/:id", {
    preHandler: requirePermission(Resource.VMS, Action.READ),
    handler: async (req, reply) => {
      const data = await gql.query<{ vms: { domains: VM[] } }>(LIST_QUERY);
      const search = req.params.id.toLowerCase();
      const vm = data.vms.domains.map(withUuid).find(
        (d) => d.name.toLowerCase() === search || d.uuid === req.params.id || d.id === req.params.id
      );
      if (!vm) {
        return reply.status(404).send({
          ok: false,
          error: { code: "NOT_FOUND", message: `VM '${req.params.id}' not found` },
        });
      }
      return reply.send({ ok: true, data: vm });
    },
  });

  // VM actions via virsh CLI
  for (const [path, virshCmd] of Object.entries(VIRSH_ACTION_MAP)) {
    app.post<{ Params: { id: string } }>(`/api/vms/:id/${path}`, {
      preHandler: requirePermission(Resource.VMS, Action.UPDATE),
      handler: async (req, reply) => {
        try {
          await execFileAsync("virsh", [virshCmd, req.params.id]);
          // Fetch updated state from virsh
          const { stdout } = await execFileAsync("virsh", ["domstate", req.params.id]);
          const state = stdout.trim();
          return reply.send({
            ok: true,
            data: { id: req.params.id, name: req.params.id, state, uuid: "" },
          });
        } catch (err: any) {
          return reply.status(400).send({
            ok: false,
            error: { code: "VM_ACTION_FAILED", message: err.message },
          });
        }
      },
    });
  }

  // Remove VM (destructive) via virsh
  app.delete<{ Params: { id: string } }>("/api/vms/:id", {
    preHandler: requirePermission(Resource.VMS, Action.DELETE),
    handler: async (req, reply) => {
      try {
        // Force-stop first if running, then undefine
        await execFileAsync("virsh", ["destroy", req.params.id]).catch(() => {});
        await execFileAsync("virsh", ["undefine", req.params.id]);
        return reply.send({ ok: true, data: { id: req.params.id, name: req.params.id } });
      } catch (err: any) {
        return reply.status(400).send({
          ok: false,
          error: { code: "VM_REMOVE_FAILED", message: err.message },
        });
      }
    },
  });
}
