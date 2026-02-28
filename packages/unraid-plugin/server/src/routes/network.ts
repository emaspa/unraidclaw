import type { FastifyInstance } from "fastify";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { Resource, Action } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

const INFO_QUERY = `query {
  info {
    os {
      hostname
    }
  }
}`;

export function registerNetworkRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  app.get("/api/network", {
    preHandler: requirePermission(Resource.NETWORK, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ info: { os: { hostname: string } } }>(INFO_QUERY);

      let interfaces: unknown[] = [];
      let routes: unknown[] = [];
      let dns: string[] = [];

      try {
        interfaces = JSON.parse(execSync("ip -j addr show", { timeout: 5000, encoding: "utf-8" }));
      } catch { /* ignore */ }

      try {
        routes = JSON.parse(execSync("ip -j route show", { timeout: 5000, encoding: "utf-8" }));
      } catch { /* ignore */ }

      try {
        const resolv = readFileSync("/etc/resolv.conf", "utf-8");
        dns = resolv.split("\n").filter(l => l.startsWith("nameserver")).map(l => l.split(/\s+/)[1]);
      } catch { /* ignore */ }

      return reply.send({
        ok: true,
        data: { hostname: data.info.os.hostname, interfaces, routes, dns },
      });
    },
  });
}
