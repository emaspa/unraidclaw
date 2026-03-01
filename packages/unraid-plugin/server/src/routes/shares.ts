import type { FastifyInstance } from "fastify";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Resource, Action } from "@unraidclaw/shared";
import type { UpdateShareRequest } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

const SHARES_DIR = "/boot/config/shares";

function humanSize(kilobytes: number): string {
  if (kilobytes < 1024) return `${kilobytes} KiB`;
  const mib = kilobytes / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  const gib = mib / 1024;
  if (gib < 1024) return `${gib.toFixed(1)} GiB`;
  const tib = gib / 1024;
  return `${tib.toFixed(2)} TiB`;
}
const VALID_ALLOCATORS = ["highwater", "fill", "most-free"];

const FIELD_MAP: Record<keyof UpdateShareRequest, string> = {
  comment: "shareComment",
  allocator: "shareAllocator",
  floor: "shareFloor",
  splitLevel: "shareSplitLevel",
};

function parseCfgFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

function writeCfgFile(path: string, data: Record<string, string>): void {
  const lines = Object.entries(data).map(([k, v]) => `${k}="${v}"`);
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
}

const LIST_QUERY = `query {
  shares {
    name
    comment
    allocator
    floor
    splitLevel
    cache
    free
    size
  }
}`;

export function registerShareRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  // List shares
  app.get("/api/shares", {
    preHandler: requirePermission(Resource.SHARE, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ shares: Array<Record<string, unknown>> }>(LIST_QUERY);
      const shares = data.shares.map((s) => ({
        ...s,
        ...(typeof s.free === "number" ? { freeHuman: humanSize(s.free as number) } : {}),
        ...(typeof s.size === "number" ? { sizeHuman: humanSize(s.size as number) } : {}),
      }));
      return reply.send({ ok: true, data: shares });
    },
  });

  // Get share by name (filter from list — no singular share query in Unraid 7)
  app.get<{ Params: { name: string } }>("/api/shares/:name", {
    preHandler: requirePermission(Resource.SHARE, Action.READ),
    handler: async (req, reply) => {
      const data = await gql.query<{ shares: Array<Record<string, unknown> & { name: string }> }>(LIST_QUERY);
      const share = data.shares.find(
        (s) => s.name.toLowerCase() === req.params.name.toLowerCase()
      );
      if (!share) {
        return reply.code(404).send({
          ok: false,
          error: { code: "NOT_FOUND", message: `Share '${req.params.name}' not found` },
        });
      }
      const enriched = {
        ...share,
        ...(typeof share.free === "number" ? { freeHuman: humanSize(share.free as number) } : {}),
        ...(typeof share.size === "number" ? { sizeHuman: humanSize(share.size as number) } : {}),
      };
      return reply.send({ ok: true, data: enriched });
    },
  });

  // Update share settings (safe fields only)
  app.patch<{ Params: { name: string }; Body: UpdateShareRequest }>("/api/shares/:name", {
    preHandler: requirePermission(Resource.SHARE, Action.UPDATE),
    handler: async (req, reply) => {
      const { name } = req.params;
      const body = req.body ?? {};

      // Validate share exists
      const data = await gql.query<{ shares: Array<{ name: string }> }>(LIST_QUERY);
      const share = data.shares.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (!share) {
        return reply.code(404).send({
          ok: false,
          error: { code: "NOT_FOUND", message: `Share '${name}' not found` },
        });
      }

      // Validate allocator value
      if (body.allocator && !VALID_ALLOCATORS.includes(body.allocator)) {
        return reply.code(400).send({
          ok: false,
          error: {
            code: "INVALID_VALUE",
            message: `Invalid allocator '${body.allocator}'. Must be one of: ${VALID_ALLOCATORS.join(", ")}`,
          },
        });
      }

      // Read existing config, apply updates, write back
      const cfgPath = `${SHARES_DIR}/${share.name}.cfg`;
      const cfg = parseCfgFile(cfgPath);

      const updated: string[] = [];
      for (const [field, cfgKey] of Object.entries(FIELD_MAP)) {
        const value = body[field as keyof UpdateShareRequest];
        if (value !== undefined) {
          cfg[cfgKey] = String(value);
          updated.push(field);
        }
      }

      if (updated.length === 0) {
        return reply.code(400).send({
          ok: false,
          error: { code: "NO_CHANGES", message: "No valid fields provided to update" },
        });
      }

      writeCfgFile(cfgPath, cfg);

      return reply.send({ ok: true, data: { share: share.name, updated } });
    },
  });
}
