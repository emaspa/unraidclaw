import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { VM } from "@unraidclaw/shared";
import { GraphQLError, type GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";
import { runCommand, type CommandRunner } from "../docker-common.js";

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

export const VMS_UNAVAILABLE_MESSAGE =
  "Unraid reports that VMs are not available because its VM service (libvirt) is not running. " +
  "It runs only while VMs are enabled in Settings > VM Manager and the array is started.";

/**
 * Lists the domains. A stopped VM service is its own error rather than an empty
 * list, so "no VMs" is never confused with "VMs are off". A null `vms` without
 * an error, which the API's schema allows since 7.4, is an empty list.
 */
async function listDomains(gql: GraphQLClient): Promise<VM[]> {
  let data: { vms: { domains: VM[] | null } | null };
  try {
    data = await gql.query<{ vms: { domains: VM[] | null } | null }>(LIST_QUERY);
  } catch (error) {
    if (error instanceof GraphQLError && error.code === "GRAPHQL_ERROR" && /VMs are not available/i.test(error.message)) {
      throw new GraphQLError(VMS_UNAVAILABLE_MESSAGE, 503, "VMS_UNAVAILABLE");
    }
    throw error;
  }
  return (data?.vms?.domains ?? []).map(withUuid);
}

// VM names can contain spaces, so accept any printable name up to 255
// characters that virsh cannot read as an option.
function validVMId(id: string): boolean {
  const domain = id.slice(id.lastIndexOf(":") + 1);
  return domain.length > 0 && id.length <= 512 && !domain.startsWith("-") && !/[\x00-\x1f\x7f]/.test(id);
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

export function registerVMRoutes(app: FastifyInstance, gql: GraphQLClient, options: {
  run?: CommandRunner;
  pollAttempts?: number;
  pollIntervalMs?: number;
} = {}): void {
  const run = options.run ?? runCommand;
  const command = async (args: string[]) => (await run("virsh", args, { timeout: 15000 })).stdout.trim();
  const identity = async (id: string) => {
    const uuid = await command(["domuuid", id.slice(id.lastIndexOf(":") + 1)]);
    if (!/^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/.test(uuid)) throw new Error("Invalid domain UUID returned by virsh");
    const name = await command(["domname", uuid]);
    return { id: uuid, uuid, name };
  };
  // List VMs
  app.get("/api/vms", {
    preHandler: requirePermission(Resource.VMS, Action.READ),
    handler: async (_req, reply) => {
      return reply.send({ ok: true, data: await listDomains(gql) });
    },
  });

  // Get VM details (filter from list)
  app.get<{ Params: { id: string } }>("/api/vms/:id", {
    preHandler: requirePermission(Resource.VMS, Action.READ),
    handler: async (req, reply) => {
      if (!validVMId(req.params.id)) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid VM ID" } });
      }
      const search = req.params.id.toLowerCase();
      const vm = (await listDomains(gql)).find(
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
        if (!validVMId(req.params.id)) {
          return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid VM ID" } });
        }
        try {
          const vm = await identity(req.params.id);
          await command([virshCmd, vm.uuid]);
          const expected = path === "stop" || path === "force-stop" ? "shut off" : path === "pause" ? "paused" : "running";
          const asynchronous = path === "stop" || path === "reboot";
          const attempts = asynchronous ? Math.max(1, Math.min(20, options.pollAttempts ?? 10)) : 1;
          let state = "";
          for (let attempt = 0; attempt < attempts; attempt++) {
            state = await command(["domstate", vm.uuid]);
            if (state === expected) break;
            if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(1000, options.pollIntervalMs ?? 500))));
          }
          const verified = state === expected;
          if (!verified && !asynchronous) {
            return reply.status(500).send({ ok: false, error: { code: "VERIFICATION_FAILED", message: `VM did not reach ${expected}` }, data: { ...vm, state, verified } });
          }
          return reply.send({
            ok: true,
            data: { ...vm, state, verified },
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
      if (!validVMId(req.params.id)) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid VM ID" } });
      }
      try {
        const vm = await identity(req.params.id);
        const state = await command(["domstate", vm.uuid]);
        if (state !== "shut off") {
          await command(["destroy", vm.uuid]);
          if (await command(["domstate", vm.uuid]) !== "shut off") {
            return reply.status(500).send({ ok: false, error: { code: "VERIFICATION_FAILED", message: "VM did not stop" }, data: { ...vm, verified: false } });
          }
        }
        await command(["undefine", vm.uuid]);
        const domains = await command(["list", "--all", "--uuid"]);
        if (domains.split(/\s+/).includes(vm.uuid)) {
          return reply.status(500).send({ ok: false, error: { code: "VERIFICATION_FAILED", message: "VM is still defined" }, data: { ...vm, verified: false } });
        }
        return reply.send({ ok: true, data: { ...vm, verified: true } });
      } catch (err: any) {
        return reply.status(400).send({
          ok: false,
          error: { code: "VM_REMOVE_FAILED", message: err.message },
        });
      }
    },
  });
}
