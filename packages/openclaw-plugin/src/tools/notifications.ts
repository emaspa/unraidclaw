import type { OpenClawApi } from "../types.js";
import type { UnraidClient } from "../client.js";
import { textResult, errorResult } from "./util.js";

export function registerNotificationTools(api: OpenClawApi, client: UnraidClient): void {
  api.registerTool({
    name: "unraid_notification_list",
    description: "List all system notifications with their importance level and archive status.",
    parameters: { type: "object" },
    execute: async () => {
      try {
        return textResult(await client.get("/api/notifications"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_notification_create",
    description: "Create a new system notification.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Notification title" },
        subject: { type: "string", description: "Notification subject" },
        description: { type: "string", description: "Notification body text" },
        importance: { type: "string", description: "Importance level: alert, warning, or normal" },
      },
      required: ["title", "subject", "description"],
    },
    execute: async (_id, params) => {
      try {
        const body: Record<string, string> = {
          title: params.title as string,
          subject: params.subject as string,
          description: params.description as string,
        };
        if (params.importance) body.importance = params.importance as string;
        return textResult(await client.post("/api/notifications", body));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_notification_archive",
    description: "Archive a notification (mark as read/handled).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Notification ID" },
      },
      required: ["id"],
    },
    execute: async (_id, params) => {
      try {
        return textResult(await client.post(`/api/notifications/${params.id}/archive`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_notification_delete",
    description: "Delete a notification permanently.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Notification ID" },
      },
      required: ["id"],
    },
    execute: async (_id, params) => {
      try {
        return textResult(await client.delete(`/api/notifications/${params.id}`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
