// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { ClientResolver } from "../index.js";
import { textResult, errorResult, checkParams } from "./util.js";

export function registerCaTools(api: any, getClient: ClientResolver): void {
  api.registerTool({
    name: "unraid_ca_search",
    description:
      "Search the Unraid Community Applications catalog by name, description, Docker image or maintainer. Returns matching apps with their icon, categories and whether UnraidClaw can install them. Use this to find an app before calling unraid_ca_app or unraid_ca_install.",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search text, e.g. 'plex' or 'backup tool'. All words must match." },
        limit: { type: "number", description: "Maximum results to return (1-100, default: 25)" },
        includeDeprecated: { type: "boolean", description: "Include templates the maintainer deprecated (default: false)" },
        includePlugins: { type: "boolean", description: "Include Unraid plugin (.plg) entries, which are not containers (default: false)" },
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      required: ["q"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        const query: Record<string, string> = { q: String(params.q ?? "") };
        if (params.limit) query.limit = String(params.limit);
        if (params.includeDeprecated) query.includeDeprecated = "true";
        if (params.includePlugins) query.includePlugins = "true";
        return textResult(await getClient(params.server as string | undefined).get("/api/ca/search", query));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_ca_app",
    description:
      "Get the full Community Applications template for one app: its Docker image, icon, WebUI, network mode, and every configurable port, volume and environment variable with its default. Also reports which required fields have no default and any reason the app cannot be installed. Several apps share a name; pass repo to disambiguate when the call reports an ambiguity.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "App name exactly as it appears in the catalog, e.g. 'Jellyfin'" },
        repo: { type: "string", description: "Owning repository, e.g. \"linuxserver's Repository\". Required when several templates share the name." },
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      required: ["name"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        const query: Record<string, string> = {};
        if (params.repo) query.repo = String(params.repo);
        return textResult(
          await getClient(params.server as string | undefined).get(
            `/api/ca/app/${encodeURIComponent(String(params.name))}`,
            query
          )
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_ca_install",
    description:
      "Install a Community Applications app on the Unraid server using its template defaults. Writes an Unraid docker-manager template and has Unraid create and start the container, so it appears on the Docker tab like any other app. Required fields with no default must be supplied in overrides; call unraid_ca_app first to see them. Pass dryRun=true to get the resolved template and a preview of the docker command without changing anything. Refuses apps whose templates need unsupported or unsafe options rather than installing something different from the template.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "App name exactly as it appears in the catalog, e.g. 'Jellyfin'" },
        repo: { type: "string", description: "Owning repository. Required when several templates share the name." },
        containerName: {
          type: "string",
          description:
            "Name for the new container. Defaults to the app name. Letters, digits, dot, dash and underscore only.",
        },
        overrides: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Values for template fields, keyed by the field's name or its container-side target, e.g. {'/data/tvshows': '/mnt/user/media/tv', 'PUID': '99'}. An unknown key is an error.",
        },
        dryRun: {
          type: "boolean",
          description: "Resolve and validate everything and return the plan without installing (default: false)",
        },
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        checkParams(params, ["name", "repo", "containerName", "overrides", "dryRun", "server"]);
        const body: Record<string, unknown> = {};
        if (params.repo) body.repo = params.repo;
        if (params.containerName) body.name = params.containerName;
        if (params.overrides) body.overrides = params.overrides;
        if (params.dryRun !== undefined) body.dryRun = params.dryRun;
        return textResult(
          await getClient(params.server as string | undefined).post(
            `/api/ca/app/${encodeURIComponent(String(params.name))}/install`,
            body
          )
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "unraid_ca_update",
    description:
      "Update an app that is already installed on the Unraid server: pulls the newest image for the tag it runs and recreates the container from the template saved on the server, keeping its ports, paths, variables and its running or stopped state. The name is the INSTALLED CONTAINER NAME as shown on the Docker tab, not the app's name in the Community Applications catalog; call unraid_docker_list to find it and never guess it from a catalog name. Nothing is refreshed from the catalog, so values the user changed are kept. A failed pull leaves the running app untouched, the previous image is never deleted, and no appdata is removed. Pass dryRun=true to see the resolved configuration and the exact docker command without changing anything.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Installed container name, e.g. 'jellyfin'. Not the catalog app name." },
        dryRun: {
          type: "boolean",
          description: "Check everything and report what would happen without pulling or recreating anything (default: false)",
        },
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        checkParams(params, ["name", "dryRun", "server"]);
        const body: Record<string, unknown> = {};
        if (params.dryRun !== undefined) body.dryRun = params.dryRun;
        return textResult(
          await getClient(params.server as string | undefined).post(
            `/api/ca/app/${encodeURIComponent(String(params.name))}/update`,
            body
          )
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "unraid_ca_remove",
    description:
      "Remove an installed app's Docker container from the Unraid server. The name is the INSTALLED CONTAINER NAME as shown on the Docker tab, not the app's name in the Community Applications catalog; call unraid_docker_list to find it and never guess it from a catalog name. Only the container is removed: its appdata, its Docker volumes, its image and the saved template all stay, so the app can be recreated with the same configuration. Pass dryRun=true to see exactly what would be removed and what would be kept.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Installed container name, e.g. 'jellyfin'. Not the catalog app name." },
        dryRun: {
          type: "boolean",
          description: "Report what would be removed and what would be kept, without removing anything (default: false)",
        },
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        checkParams(params, ["name", "dryRun", "server"]);
        const body: Record<string, unknown> = {};
        if (params.dryRun !== undefined) body.dryRun = params.dryRun;
        return textResult(
          await getClient(params.server as string | undefined).post(
            `/api/ca/app/${encodeURIComponent(String(params.name))}/remove`,
            body
          )
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  }, { optional: true });
}
