import type { ToolResult } from "../types.js";

export function textResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// Track failures without changing the result object OpenClaw receives.
const failures = new WeakSet<ToolResult>();

export function isErrorResult(result: ToolResult): boolean {
  return failures.has(result);
}

export function errorResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const result: ToolResult = { content: [{ type: "text", text: `Error: ${message}` }] };
  failures.add(result);
  return result;
}

/**
 * Check a mutating tool's arguments before anything is sent.
 *
 * The server refuses a body it does not recognise, but a tool call never
 * becomes that body: `execute` copies the keys it knows about and drops the
 * rest. A caller who writes `dryrun: true` would have the flag silently
 * discarded and get a real install, update or removal where they asked for a
 * preview. So the same check happens here, before the request exists, and an
 * unknown key or a non-boolean `dryRun` is an error rather than a mutation.
 *
 * Declaring `additionalProperties: false` on the schema is the other half of
 * this: it tells the model what is allowed. This is what enforces it.
 */
export function checkParams(params: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(params)) {
    if (allowed.includes(key)) continue;
    const near = allowed.find((a) => a.toLowerCase() === key.toLowerCase());
    throw new Error(
      near
        ? `Unknown parameter "${key}". Did you mean "${near}"? Nothing was sent to the server.`
        : `Unknown parameter "${key}". Allowed parameters are: ${allowed.join(", ")}. Nothing was sent to the server.`
    );
  }
  if (params.dryRun !== undefined && typeof params.dryRun !== "boolean") {
    throw new Error(
      `"dryRun" must be true or false, not ${JSON.stringify(params.dryRun)}. Nothing was sent to the server.`
    );
  }
}
