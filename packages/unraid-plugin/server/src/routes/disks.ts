import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Resource, Action } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

const execFileAsync = promisify(execFile);

function humanSize(kilobytes: number): string {
  if (kilobytes < 1024) return `${kilobytes} KiB`;
  const mib = kilobytes / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  const gib = mib / 1024;
  if (gib < 1024) return `${gib.toFixed(1)} GiB`;
  const tib = gib / 1024;
  return `${tib.toFixed(2)} TiB`;
}

interface DfEntry { mount: string; sizeKB: number; usedKB: number; freeKB: number; }

async function getDiskUsage(): Promise<Map<string, DfEntry>> {
  const map = new Map<string, DfEntry>();
  try {
    const { stdout } = await execFileAsync("df", ["-k", "--output=target,size,used,avail"], { timeout: 5000 });
    for (const line of stdout.trim().split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const [mount, size, used, avail] = parts;
      // Match /mnt/disk1, /mnt/disk2, etc.
      const m = mount.match(/^\/mnt\/(disk\d+|cache\d*|parity\d*)$/);
      if (m) {
        map.set(m[1], { mount, sizeKB: parseInt(size, 10), usedKB: parseInt(used, 10), freeKB: parseInt(avail, 10) });
      }
    }
  } catch {
    // df may fail; return empty map
  }
  return map;
}

function enrichDisk(d: Record<string, unknown>, usage: Map<string, DfEntry>) {
  const name = d.name as string;
  const df = usage.get(name);
  return {
    ...d,
    ...(typeof d.size === "number" ? { sizeHuman: humanSize(d.size as number) } : {}),
    ...(df ? {
      usedKB: df.usedKB,
      freeKB: df.freeKB,
      usedHuman: humanSize(df.usedKB),
      freeHuman: humanSize(df.freeKB),
      usedPercent: df.sizeKB > 0 ? Math.round((df.usedKB / df.sizeKB) * 1000) / 10 : 0,
    } : {}),
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
      const usage = await getDiskUsage();
      const allDisks = [...data.array.disks, ...data.array.parities].map((d) => enrichDisk(d, usage));
      return reply.send({ ok: true, data: allDisks });
    },
  });

  // Disk details (filter from combined list, no singular disk query available)
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
      const usage = await getDiskUsage();
      return reply.send({ ok: true, data: enrichDisk(disk, usage) });
    },
  });
}
