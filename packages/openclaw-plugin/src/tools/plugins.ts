// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { ClientResolver } from "../index.js";
import { textResult, errorResult, checkParams } from "./util.js";

export function registerPluginTools(api: any, getClient: ClientResolver): void {
  api.registerTool({
    name: "unraid_plugins_list",
    description:
      "List the Unraid plugins (.plg) installed on the server, with author, version, update URL and whether an update is already staged. Unraid plugins are not Docker containers and not Community Applications: they install files and run scripts on the server itself. Plugins marked builtin belong to Unraid OS and cannot be changed through UnraidClaw.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        return textResult(await getClient(params.server as string | undefined).get("/api/plugins"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_plugin_info",
    description:
      "Show one installed Unraid plugin in full: its metadata, support link, Unraid version requirements, changelog text and the structure of the files it installs. Inline scripts inside the plugin are described but never returned or executed.",
    parameters: {
      type: "object",
      properties: {
        plugin: {
          type: "string",
          description: "Plugin file name, e.g. 'unassigned.devices.plg'. The .plg suffix is optional.",
        },
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      required: ["plugin"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        return textResult(
          await getClient(params.server as string | undefined).get(
            `/api/plugins/${encodeURIComponent(String(params.plugin))}`
          )
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool(
    {
      name: "unraid_plugin_install",
      description:
        "Install an Unraid plugin from an explicit https URL to a .plg file. The plugin file is an installer that Unraid runs as root, so this executes code from whoever controls that URL: only use a URL the user gave you or one from a source they trust. The URL must be https, public, credential-free and end in .plg. Use dryRun first to see exactly what would happen. This is not the way to install Community Applications apps; those are Docker containers (unraid_ca_install).",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Direct https URL of the .plg file, e.g. 'https://example.com/myplugin.plg'",
          },
          dryRun: {
            type: "boolean",
            description:
              "Validate the URL and return the plan without downloading, writing or installing anything (default: false)",
          },
          server: { type: "string", description: "Target server name (optional, uses default server)" },
        },
        required: ["url"],
        additionalProperties: false,
      },
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          checkParams(params, ["url", "dryRun", "server"]);
          const body: Record<string, unknown> = { url: String(params.url ?? "") };
          if (params.dryRun !== undefined) body.dryRun = params.dryRun;
          return textResult(
            await getClient(params.server as string | undefined).post("/api/plugins/install", body)
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    { optional: true }
  );

  api.registerTool(
    {
      name: "unraid_plugin_check_updates",
      description:
        "Check whether a newer version of an installed Unraid plugin has been published, and stage it for installation. This is not a read-only lookup: it downloads the plugin file from the plugin's own update URL and writes it to the plugin manager's staging directory, where this tool's update call and the Unraid web UI will then offer to install it. Nothing is installed or executed by the check. Run this before unraid_plugin_update.",
      parameters: {
        type: "object",
        properties: {
          plugin: { type: "string", description: "Plugin file name, e.g. 'unassigned.devices.plg'" },
          dryRun: {
            type: "boolean",
            description: "Return the plan without downloading or staging anything (default: false)",
          },
          server: { type: "string", description: "Target server name (optional, uses default server)" },
        },
        required: ["plugin"],
        additionalProperties: false,
      },
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          checkParams(params, ["plugin", "dryRun", "server"]);
          const body: Record<string, unknown> = {};
          if (params.dryRun !== undefined) body.dryRun = params.dryRun;
          return textResult(
            await getClient(params.server as string | undefined).post(
              `/api/plugins/${encodeURIComponent(String(params.plugin))}/check`,
              body
            )
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    { optional: true }
  );

  api.registerTool(
    {
      name: "unraid_plugin_update",
      description:
        "Install the plugin version staged by unraid_plugin_check_updates. Unraid's plugin manager runs the new plugin's install scripts as root and there is no rollback. The result says whether the installed version actually changed; a plugin manager exit code alone is not treated as success.",
      parameters: {
        type: "object",
        properties: {
          plugin: { type: "string", description: "Plugin file name, e.g. 'unassigned.devices.plg'" },
          dryRun: {
            type: "boolean",
            description: "Return the plan, including which version would replace which, without installing (default: false)",
          },
          server: { type: "string", description: "Target server name (optional, uses default server)" },
        },
        required: ["plugin"],
        additionalProperties: false,
      },
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          checkParams(params, ["plugin", "dryRun", "server"]);
          const body: Record<string, unknown> = {};
          if (params.dryRun !== undefined) body.dryRun = params.dryRun;
          return textResult(
            await getClient(params.server as string | undefined).post(
              `/api/plugins/${encodeURIComponent(String(params.plugin))}/update`,
              body
            )
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    { optional: true }
  );

  api.registerTool(
    {
      name: "unraid_plugin_remove",
      description:
        "Remove an installed Unraid plugin through the plugin manager. The plugin's own removal scripts run as root and decide what they delete: some keep their configuration and data, others delete it, so removal cannot be promised to be data-preserving. Anything depending on the plugin stops working. Use dryRun first and confirm with the user before removing.",
      parameters: {
        type: "object",
        properties: {
          plugin: { type: "string", description: "Plugin file name, e.g. 'unassigned.devices.plg'" },
          dryRun: {
            type: "boolean",
            description: "Return the plan and its warnings without removing anything (default: false)",
          },
          server: { type: "string", description: "Target server name (optional, uses default server)" },
        },
        required: ["plugin"],
        additionalProperties: false,
      },
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          checkParams(params, ["plugin", "dryRun", "server"]);
          const body: Record<string, unknown> = {};
          if (params.dryRun !== undefined) body.dryRun = params.dryRun;
          return textResult(
            await getClient(params.server as string | undefined).post(
              `/api/plugins/${encodeURIComponent(String(params.plugin))}/remove`,
              body
            )
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    { optional: true }
  );
}
