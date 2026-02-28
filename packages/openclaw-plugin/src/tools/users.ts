import type { ToolRegistrar } from "./health.js";
import type { UnraidClient } from "../client.js";
import type { UserInfo } from "@unraidclaw/shared";

export function registerUserTools(api: ToolRegistrar, client: UnraidClient): void {
  api.register({
    name: "unraid_user_me",
    description: "Get information about the current authenticated user.",
    parameters: {},
    handler: async () => {
      return client.get<UserInfo>("/api/users/me");
    },
  });
}
