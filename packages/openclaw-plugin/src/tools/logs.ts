// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { UnraidClient } from "../client.js";
import { textResult, errorResult } from "./util.js";

export function registerLogTools(api: any, client: UnraidClient): void {
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
      },
    },
    execute: async (_id: string, params: { lines?: number }) => {
      try {
        const query: Record<string, string> = {};
        if (params.lines) query.lines = String(params.lines);
        return textResult(await client.get("/api/logs/syslog", query));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
