import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { ServerConfig } from "./config.js";

export function hashApiKey(plainKey: string): string {
  return createHash("sha256").update(plainKey).digest("hex");
}

export function verifyApiKey(plainKey: string, storedHash: string): boolean {
  if (!storedHash || !plainKey) return false;
  const incomingHash = hashApiKey(plainKey);
  const a = Buffer.from(incomingHash, "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createAuthHook(config: ServerConfig) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Skip auth for health endpoint
    if (request.url === "/api/health") return;

    const apiKey = request.headers["x-api-key"] as string | undefined;
    if (!apiKey) {
      reply.code(401).send({
        ok: false,
        error: { code: "UNAUTHORIZED", message: "Missing x-api-key header" },
      });
      return;
    }

    if (!verifyApiKey(apiKey, config.apiKeyHash)) {
      reply.code(401).send({
        ok: false,
        error: { code: "UNAUTHORIZED", message: "Invalid API key" },
      });
      return;
    }
  };
}
