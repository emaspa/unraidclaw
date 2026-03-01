import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

function humanSize(kilobytes: number): string {
  if (kilobytes < 1024) return `${kilobytes} KiB`;
  const mib = kilobytes / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  const gib = mib / 1024;
  if (gib < 1024) return `${gib.toFixed(1)} GiB`;
  const tib = gib / 1024;
  return `${tib.toFixed(2)} TiB`;
}

function enrichDisk(d: Record<string, unknown>) {
  return {
    ...d,
    ...(typeof d.size === "number" ? { sizeHuman: humanSize(d.size as number) } : {}),
  };
}

// Unraid 7: root "disks" query times out. Use array.disks + array.parities instead.
const LIST_QUERY = `query {
  array {
    disks {
      name
      device
      size
      temp
      status
      fsType
    }
    parities {
      name
      device
      size
      status
      numErrors
    }
  }
}`;

export function registerDiskRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  // List all disks (data + parity combined)
  app.get("/api/disks", {
    preHandler: requirePermission(Resource.DISK, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{
        array: {
          disks: Array<Record<string, unknown>>;
          parities: Array<Record<string, unknown>>;
        };
      }>(LIST_QUERY);
      const allDisks = [...data.array.disks, ...data.array.parities].map(enrichDisk);
      return reply.send({ ok: true, data: allDisks });
    },
  });

  // Disk details (filter from combined list — no singular disk query available)
  app.get<{ Params: { id: string } }>("/api/disks/:id", {
    preHandler: requirePermission(Resource.DISK, Action.READ),
    handler: async (req, reply) => {
      const data = await gql.query<{
        array: {
          disks: Array<Record<string, unknown> & { name: string }>;
          parities: Array<Record<string, unknown> & { name: string }>;
        };
      }>(LIST_QUERY);
      const allDisks = [...data.array.disks, ...data.array.parities];
      const disk = allDisks.find(
        (d) => d.name.toLowerCase() === req.params.id.toLowerCase()
      );
      if (!disk) {
        return reply.code(404).send({
          ok: false,
          error: { code: "NOT_FOUND", message: `Disk '${req.params.id}' not found` },
        });
      }
      return reply.send({ ok: true, data: enrichDisk(disk) });
    },
  });
}
