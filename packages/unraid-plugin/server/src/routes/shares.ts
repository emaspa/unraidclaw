import type { FastifyInstance } from "fastify";
import { readFileSync, writeFileSync, existsSync, statSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { Resource, Action } from "@unraidclaw/shared";
import type { UpdateShareRequest } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

import { randomUUID } from "node:crypto";
import { validBody, validInteger } from "../docker-common.js";

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
  const temp = `${path}.${randomUUID()}.tmp`;
  const mode = existsSync(path) ? statSync(path).mode & 0o7777 : 0o600;
  try {
    writeFileSync(temp, lines.join("\n") + "\n", { encoding: "utf-8", mode, flag: "wx" });
    // /boot is vfat, where the mount options fix file modes and chmod can fail.
    try { chmodSync(temp, mode); } catch { /* keep the mode the mount gives */ }
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
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

export function registerShareRoutes(app: FastifyInstance, gql: GraphQLClient, sharesDir = SHARES_DIR): void {
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

  // Get share by name (filter from list, no singular share query in Unraid 7)
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
      const body = req.body;
      if (!validBody(body, Object.keys(FIELD_MAP))) {
        return reply.code(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid share fields" } });
      }

      // Validate share exists
      const data = await gql.query<{ shares: Array<{ name: string }> }>(LIST_QUERY);
      const share = data.shares.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (!share) {
        return reply.code(404).send({
          ok: false,
          error: { code: "NOT_FOUND", message: `Share '${name}' not found` },
        });
      }

      // Validate field values
      if (body.allocator !== undefined && (typeof body.allocator !== "string" || !VALID_ALLOCATORS.includes(body.allocator))) {
        return reply.code(400).send({
          ok: false,
          error: {
            code: "INVALID_VALUE",
            message: `Invalid allocator '${body.allocator}'. Must be one of: ${VALID_ALLOCATORS.join(", ")}`,
          },
        });
      }
      if (body.floor !== undefined) {
        if (!validInteger(body.floor)) {
          return reply.code(400).send({
            ok: false,
            error: { code: "INVALID_VALUE", message: "floor must be a non-negative integer (KiB)" },
          });
        }
      }
      if (body.splitLevel !== undefined) {
        if (!validInteger(body.splitLevel)) {
          return reply.code(400).send({
            ok: false,
            error: { code: "INVALID_VALUE", message: "splitLevel must be a non-negative integer" },
          });
        }
      }
      if (body.comment !== undefined) {
        if (typeof body.comment !== "string" || body.comment.length > 256 || /[\x00-\x1f\x7f-\x9f"\\$`]/.test(body.comment)) {
          return reply.code(400).send({
            ok: false,
            error: { code: "INVALID_VALUE", message: "comment must be a string of 256 characters or fewer" },
          });
        }
      }

      // Read existing config, apply updates, write back
      if (!share.name || /[/\\\x00]/.test(share.name) || share.name === "." || share.name === "..") {
        return reply.code(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid share name" } });
      }
      const cfgPath = `${sharesDir}/${share.name}.cfg`;
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

      const observed = parseCfgFile(cfgPath);
      if (updated.some((field) => observed[FIELD_MAP[field as keyof UpdateShareRequest]] !== cfg[FIELD_MAP[field as keyof UpdateShareRequest]])) {
        return reply.code(500).send({ ok: false, error: { code: "VERIFICATION_FAILED", message: "Share settings did not persist" } });
      }
      return reply.send({ ok: true, data: { share: share.name, updated, verified: true } });
    },
  });
}
