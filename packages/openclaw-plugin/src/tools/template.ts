// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { ClientResolver } from "../registry.js";
import { textResult, errorResult, checkParams } from "./util.js";

const CONFIG_TYPE = { type: "string", enum: ["Port", "Path", "Variable", "Label", "Device"] };

const CONFIG_EDIT = {
  type: "object",
  properties: {
    type: CONFIG_TYPE,
    target: { type: "string", description: "Container port, container path, variable name or label name. Leave out for a Device." },
    value: { type: "string", description: "Host port, host path, variable value, label value, or host device path such as /dev/dri. An empty string clears the value." },
    mode: { type: "string", description: "Port: tcp (default) or udp. Path: rw (default), ro, rw,slave, ro,slave, rw,shared or ro,shared." },
    name: { type: "string", description: "Label shown on the Docker tab. Defaults to the target on a new entry." },
    default: { type: "string" },
    description: { type: "string" },
    display: { type: "string", enum: ["always", "always-hide", "advanced", "advanced-hide"] },
    required: { type: "boolean" },
    mask: { type: "boolean", description: "True for a password or API key, so it is hidden everywhere." },
    replaces: { type: "string", description: "Device only: the device path currently configured, when changing it to value." },
  },
  required: ["type", "value"],
  additionalProperties: false,
};

const CONFIG_REF = {
  type: "object",
  properties: {
    type: CONFIG_TYPE,
    target: { type: "string", description: "Container port, container path, variable or label name." },
    mode: { type: "string", description: "Port protocol, tcp (default) or udp." },
    value: { type: "string", description: "Device only: the host device path to remove." },
  },
  required: ["type"],
  additionalProperties: false,
};

export function registerTemplateTools(api: any, getClient: ClientResolver): void {
  api.registerTool({
    name: "unraid_template_get",
    description:
      "Read the saved Unraid template of an installed container: every setting the Docker tab's edit form shows, such as image, network, fixed IP, privileged mode, Extra Parameters, Post Arguments, CPU pinning, memory limit and Tailscale, plus each port, path, variable, label and device. Masked values such as passwords, and values under a secret-looking name such as TUNNEL_TOKEN, come back as ***. The name is the installed container name as shown on the Docker tab; call unraid_docker_list to find it. Use this before unraid_template_edit to see what is there.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Installed container name, e.g. 'jellyfin'." },
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        checkParams(params, ["name", "server"]);
        return textResult(
          await getClient(params.server as string | undefined).get(`/api/template/${encodeURIComponent(String(params.name))}`)
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_template_edit",
    description:
      "Change an installed container's settings and rebuild it, the way editing it on the Docker tab and clicking Apply does. Anything the Docker tab supports works: ports, paths, variables, labels, devices, network and fixed IP, extra networks, privileged mode, Extra Parameters, Post Arguments, CPU pinning, memory limit and Tailscale. Unraid's own docker manager builds the command from the edited template. The new container is created before the running one is touched; if it fails to start, or stops within a few seconds, the original container comes back as it was, its template is left unchanged, and the new container's last log lines are returned. The template is only saved once the rebuilt container checks out, and a copy of the old one is kept. Docker volumes the container already has are carried over. Settings the request does not name are kept. Config entries are matched by type and target, plus protocol for a port and device path for a device; an entry that does not exist yet is added. It changes settings, not the app version, unless pull=true: then the newest image for the template's tag is pulled first and the container is rebuilt on it, which updates any container, privileged ones included, and does nothing when the image is already the newest. Use pull=true, with no other changes, to update an app that unraid_ca_update refuses. Always call it with dryRun=true first and show the user the changes and the command before running it for real.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Installed container name, e.g. 'jellyfin'. Renaming is not supported." },
        settings: {
          type: "object",
          description:
            "Template elements to set, as text. e.g. {\"Network\": \"br0\", \"MyIP\": \"192.168.1.60\", \"Privileged\": \"true\", \"ExtraParams\": \"--device=/dev/dri\", \"Repository\": \"lscr.io/linuxserver/jellyfin:10.10.0\"}. Privileged and TailscaleEnabled take \"true\" or \"false\". ExtraParams and PostArgs take only letters, digits, : . , / + = _ - and single spaces, because Unraid hands them to the shell unescaped. An empty string clears a setting.",
          properties: {
            Repository: { type: "string" }, Registry: { type: "string" }, Network: { type: "string" },
            MyIP: { type: "string" }, MyMAC: { type: "string" }, ExtraNetworks: { type: "string" },
            Privileged: { type: "string", enum: ["true", "false"] }, ExtraParams: { type: "string" },
            PostArgs: { type: "string" }, CPUset: { type: "string" }, Memory: { type: "string" },
            WebUI: { type: "string" }, Icon: { type: "string" }, Shell: { type: "string" },
            TailscaleEnabled: { type: "string", enum: ["true", "false"] }, TailscaleIsExitNode: { type: "string" },
            TailscaleHostname: { type: "string" }, TailscaleExitNodeIP: { type: "string" }, TailscaleSSH: { type: "string" },
            TailscaleLANAccess: { type: "string" }, TailscaleUserspaceNetworking: { type: "string" },
            TailscaleServe: { type: "string" }, TailscaleServePort: { type: "string" }, TailscaleServeTarget: { type: "string" },
            TailscaleServeLocalPath: { type: "string" }, TailscaleServeProtocol: { type: "string" },
            TailscaleServeProtocolPort: { type: "string" }, TailscaleServePath: { type: "string" },
            TailscaleWebUI: { type: "string" }, TailscaleDParams: { type: "string" }, TailscaleParams: { type: "string" },
            TailscaleRoutes: { type: "string" }, TailscaleAcceptRoutes: { type: "string" },
            TailscaleStateDir: { type: "string" }, TailscaleTroubleshooting: { type: "string" },
          },
          additionalProperties: false,
        },
        config: { type: "array", description: "Ports, paths, variables, labels or devices to add or change.", items: CONFIG_EDIT },
        removeConfig: { type: "array", description: "Ports, paths, variables, labels or devices to remove.", items: CONFIG_REF },
        pull: { type: "boolean", description: "Pull the newest image for the tag first and rebuild on it: an update. With nothing else to change and no newer image, nothing happens (default: false)." },
        dryRun: {
          type: "boolean",
          description: "Report the changes, the exact command and what would be created, without touching anything (default: false)",
        },
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        checkParams(params, ["name", "settings", "config", "removeConfig", "pull", "dryRun", "server"]);
        const body: Record<string, unknown> = {};
        for (const key of ["settings", "config", "removeConfig", "pull", "dryRun"]) {
          if (params[key] !== undefined) body[key] = params[key];
        }
        return textResult(
          await getClient(params.server as string | undefined).post(
            `/api/template/${encodeURIComponent(String(params.name))}/edit`,
            body
          )
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  }, { optional: true });
}
