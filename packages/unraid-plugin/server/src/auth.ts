import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { ServerConfig } from "./config.js";
import { isMcpPath, mcpApiKey } from "./mcp-security.js";

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

// Rate limiting for auth failures
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10; // max failures per window
const failMap = new Map<string, { count: number; firstAttempt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = failMap.get(ip);
  if (!entry || now - entry.firstAttempt > RATE_LIMIT_WINDOW) return false;
  return entry.count >= RATE_LIMIT_MAX;
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = failMap.get(ip);
  if (!entry || now - entry.firstAttempt > RATE_LIMIT_WINDOW) {
    failMap.set(ip, { count: 1, firstAttempt: now });
  } else {
    entry.count++;
  }
}

// Periodic cleanup of stale entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failMap) {
    if (now - entry.firstAttempt > RATE_LIMIT_WINDOW) failMap.delete(ip);
  }
}, RATE_LIMIT_WINDOW).unref();

export function createAuthHook(config: ServerConfig) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Skip auth for health endpoint. Match the route, not the raw URL, so a
    // query string such as /api/health?x=1 is treated the same way.
    if (request.routeOptions.url === "/api/health") return;
    // Unknown paths answer 404 without a key. MCP clients probe OAuth discovery
    // paths such as /.well-known/oauth-protected-resource before connecting,
    // and counting those as failed logins locked them out of /mcp.
    if (request.is404) return;

    if (isRateLimited(request.ip)) {
      reply.code(429).send({
        ok: false,
        error: { code: "RATE_LIMITED", message: "Too many failed attempts. Try again later." },
      });
      return;
    }

    const mcp = config.mcpEnabled && isMcpPath(request.url);
    const apiKey = mcp ? mcpApiKey(request) : request.headers["x-api-key"] as string | undefined;
    if (!apiKey) {
      recordAuthFailure(request.ip);
      reply.code(401).send({
        ok: false,
        error: { code: "UNAUTHORIZED", message: mcp ? "Missing API key" : "Missing x-api-key header" },
      });
      return;
    }

    if (!verifyApiKey(apiKey, config.apiKeyHash)) {
      recordAuthFailure(request.ip);
      reply.code(401).send({
        ok: false,
        error: { code: "UNAUTHORIZED", message: "Invalid API key" },
      });
      return;
    }
  };
}
