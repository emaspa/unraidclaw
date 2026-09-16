import { networkInterfaces } from "node:os";
import type { FastifyRequest } from "fastify";
import type { ServerConfig } from "./config.js";

export function isMcpPath(url: string): boolean {
  try {
    // Fastify matches percent-encoded static paths too. Apply the same security
    // checks to every spelling of the registered endpoint.
    return decodeURIComponent(url.split("?", 1)[0]) === "/mcp";
  } catch {
    return false;
  }
}

export function mcpApiKey(request: FastifyRequest): string | undefined {
  const key = request.headers["x-api-key"];
  if (typeof key === "string") return key;
  const authorization = request.headers.authorization;
  return authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
}

/** Never derive trusted origins from attacker-controlled Host/forwarded headers. */
export function mcpOrigins(config: ServerConfig, tls: boolean, interfaces = networkInterfaces): Set<string> {
  const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (config.host !== "0.0.0.0" && config.host !== "::") hosts.add(config.host);
  try {
    for (const addresses of Object.values(interfaces())) {
      for (const { address } of addresses ?? []) hosts.add(address);
    }
  } catch {
    // Restricted hosts may forbid interface enumeration. Keep the explicit
    // bind address and loopback origins instead of preventing REST startup.
  }
  const origins = new Set<string>();
  for (const host of hosts) {
    try {
      const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      origins.add(new URL(`${tls ? "https" : "http"}://${authority}:${config.port}`).origin);
    } catch {
      // Scoped IPv6 addresses cannot be represented as browser origins.
    }
  }
  return origins;
}

export function validMcpOrigin(origin: string | undefined, allowed: Set<string>): boolean {
  if (origin === undefined) return true;
  // Exact serialized origins also reject credentials, paths, fragments and null.
  return allowed.has(origin);
}
