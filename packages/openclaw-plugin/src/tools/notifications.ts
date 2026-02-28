import type { ToolRegistrar } from "./health.js";
import type { UnraidClient } from "../client.js";
import type { Notification, CreateNotificationRequest } from "@unraidclaw/shared";

export function registerNotificationTools(api: ToolRegistrar, client: UnraidClient): void {
  api.register({
    name: "unraid_notification_list",
    description: "List all system notifications with their importance level and archive status.",
    parameters: {},
    handler: async () => {
      return client.get<Notification[]>("/api/notifications");
    },
  });

  api.register({
    name: "unraid_notification_create",
    description: "Create a new system notification.",
    parameters: {
      title: { type: "string", description: "Notification title", required: true },
      subject: { type: "string", description: "Notification subject", required: true },
      description: { type: "string", description: "Notification body text", required: true },
      importance: { type: "string", description: "Importance level: alert, warning, or normal" },
    },
    handler: async (params) => {
      const body: CreateNotificationRequest = {
        title: params.title as string,
        subject: params.subject as string,
        description: params.description as string,
      };
      if (params.importance) body.importance = params.importance as "alert" | "warning" | "normal";
      return client.post("/api/notifications", body);
    },
  });

  api.register({
    name: "unraid_notification_archive",
    description: "Archive a notification (mark as read/handled).",
    parameters: {
      id: { type: "string", description: "Notification ID", required: true },
    },
    handler: async (params) => {
      return client.post(`/api/notifications/${params.id}/archive`);
    },
  });

  api.register({
    name: "unraid_notification_delete",
    description: "Delete a notification permanently.",
    parameters: {
      id: { type: "string", description: "Notification ID", required: true },
    },
    handler: async (params) => {
      return client.delete(`/api/notifications/${params.id}`);
    },
  });
}
