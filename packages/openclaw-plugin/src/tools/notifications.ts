// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { ClientResolver } from "../registry.js";
import { textResult, errorResult } from "./util.js";

export function registerNotificationTools(api: any, getClient: ClientResolver): void {
  api.registerTool({
    name: "unraid_notification_list",
    description: "List all system notifications with their importance level and archive status.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        return textResult(await getClient(params.server as string | undefined).get("/api/notifications"));
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
        importance: { type: "string", enum: ["normal", "warning", "alert"], description: "Importance level: alert, warning, or normal" },
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      required: ["title", "subject", "description"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        const body: Record<string, string> = {
          title: params.title as string,
          subject: params.subject as string,
          description: params.description as string,
        };
        if (params.importance) body.importance = params.importance as string;
        return textResult(await getClient(params.server as string | undefined).post("/api/notifications", body));
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
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      required: ["id"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        return textResult(await getClient(params.server as string | undefined).post(`/api/notifications/${params.id}/archive`));
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
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      required: ["id"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        return textResult(await getClient(params.server as string | undefined).delete(`/api/notifications/${params.id}`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
