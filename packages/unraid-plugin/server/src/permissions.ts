import type { FastifyRequest, FastifyReply } from "fastify";
import { type Resource, type Action, isPermitted } from "@unraidclaw/shared";
import { getPermissions } from "./config.js";

export function requirePermission(resource: Resource, action: Action) {
  return async function permissionHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const matrix = getPermissions();
    if (!isPermitted(matrix, resource, action)) {
      reply.code(403).send({
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: `Permission denied: ${resource}:${action}`,
        },
      });
    }
  };
}
