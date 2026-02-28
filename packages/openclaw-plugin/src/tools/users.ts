import type { OpenClawApi } from "../types.js";
import type { UnraidClient } from "../client.js";
import { textResult, errorResult } from "./util.js";

export function registerUserTools(api: OpenClawApi, client: UnraidClient): void {
  api.registerTool({
    name: "unraid_user_me",
    description: "Get information about the current authenticated user.",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.get("/api/users/me"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
