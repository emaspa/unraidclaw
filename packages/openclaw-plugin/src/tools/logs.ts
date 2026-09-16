// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { ClientResolver } from "../registry.js";
import { textResult, errorResult } from "./util.js";

export function registerLogTools(api: any, getClient: ClientResolver): void {
  api.registerTool({
    name: "unraid_syslog",
    description: "Get recent syslog entries from the Unraid server. Returns the most recent log lines.",
    parameters: {
      type: "object",
      properties: {
        lines: {
          type: "number",
          description: "Number of log lines to retrieve (1-1000, default 50).",
        },
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        const query: Record<string, string> = {};
        if (params.lines) query.lines = String(params.lines);
        return textResult(await getClient(params.server as string | undefined).get("/api/logs/syslog", query));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
