# unraidclaw

> OpenClaw plugin to manage your Unraid server through AI agents: Docker, VMs, array, shares, system, notifications, and more, with permission control.

[![npm](https://img.shields.io/npm/v/unraidclaw)](https://www.npmjs.com/package/unraidclaw)

This is the [OpenClaw](https://github.com/openclaw/openclaw) plugin for **[UnraidClaw](https://github.com/emaspa/unraidclaw)**. It exposes **55 tools** to any AI agent running on OpenClaw, letting it monitor and manage your Unraid server. The plugin talks to the UnraidClaw gateway (a permission-enforcing REST API) running on your Unraid box.

## Prerequisites

1. **The UnraidClaw plugin installed on your Unraid server.** Install it from the Unraid Community Apps store, or see the [main repo](https://github.com/emaspa/unraidclaw). It runs the gateway on port `9876` (HTTPS) by default.
2. **An UnraidClaw API key.** Generate one on the **Settings > UnraidClaw** page in the Unraid WebGUI.
3. **OpenClaw** installed (`openclaw --version`).

## Install

```bash
openclaw plugins install clawhub:unraidclaw --accept-capabilities
```

The same package is on npm. OpenClaw asks you to confirm installs from outside ClawHub, so installing from npm needs `--force`:

```bash
openclaw plugins install unraidclaw --force --accept-capabilities
```

To update to the latest version:

```bash
openclaw plugins update unraidclaw --accept-capabilities
```

Then restart the gateway with `openclaw gateway restart` so it loads the new version.

## Configure

Edit `~/.openclaw/openclaw.json`.

**Single server:**

```json
{
  "plugins": {
    "allow": ["unraidclaw"],
    "entries": {
      "unraidclaw": {
        "config": {
          "serverUrl": "https://YOUR_UNRAID_IP:9876",
          "apiKey": "YOUR_API_KEY",
          "tlsSkipVerify": true
        }
      }
    }
  }
}
```

**Multiple servers:**

```json
{
  "plugins": {
    "allow": ["unraidclaw"],
    "entries": {
      "unraidclaw": {
        "config": {
          "servers": [
            { "name": "home", "serverUrl": "https://<home-server>:9876", "apiKey": "<api-key>", "tlsSkipVerify": true, "default": true },
            { "name": "work", "serverUrl": "https://<work-server>:9876", "apiKey": "<api-key>" }
          ]
        }
      }
    }
  }
}
```

With multi-server config, every tool accepts an optional `server` parameter (e.g. `unraid_docker_list(server: "work")`); the first server marked `default` is used when it's omitted, or the first configured server if none is marked.

Set `tlsSkipVerify: true` to accept the gateway's self-signed certificate. The plugin does not verify the certificate in that mode, so regenerating the certificate on the server does not affect it. The repository README's [TLS certificate](https://github.com/emaspa/unraidclaw#tls-certificate) section explains what the certificate contains and how strict clients can trust it.

### Keeping the API key out of the config file

You don't have to hard-code the key in `openclaw.json`. Two options:

**Environment variable.** OpenClaw expands `${VAR}` references at config-load time:

```json
"apiKey": "${UNRAID_API_KEY}"
```

**Provider-backed secret (`SecretRef`).** Point `apiKey` at one of your configured secret providers; OpenClaw resolves it before the plugin loads, so the plugin only ever sees the resolved string:

```json
"apiKey": { "source": "file", "provider": "default", "id": "/unraidclaw_key" }
```

`source` is one of `file`, `env`, or `exec`; `provider` names a provider from your `secrets.providers` config; `id` is the lookup key. Both forms also work per-server on `servers[].apiKey`. (Requires unraidclaw 0.1.12+.)

## Usage

Once installed and configured, ask your agent:

- "List all running Docker containers"
- "Stop the plex container"
- "What's the array status?"
- "Show me disk temperatures"
- "Create a new nginx container with port 8080"
- "Find me a Community Applications backup tool"
- "Install Jellyfin from Community Applications, media on /mnt/user/media"
- "Update the jellyfin container to the latest image"
- "Which of my Unraid plugins have updates?"
- "Check parity status"
- "Reboot the server"

## Tools

55 tools across 13 categories:

| Category | Tools |
|----------|-------|
| Health | `unraid_health_check` |
| Docker | `unraid_docker_list`, `unraid_docker_inspect`, `unraid_docker_logs`, `unraid_docker_create`, `unraid_docker_start`, `unraid_docker_stop`, `unraid_docker_restart`, `unraid_docker_pause`, `unraid_docker_unpause`, `unraid_docker_remove` |
| Community Apps | `unraid_ca_search`, `unraid_ca_app`, `unraid_ca_install`, `unraid_ca_update`, `unraid_ca_remove` |
| Plugins | `unraid_plugins_list`, `unraid_plugin_info`, `unraid_plugin_install`, `unraid_plugin_check_updates`, `unraid_plugin_update`, `unraid_plugin_remove` |
| VMs | `unraid_vm_list`, `unraid_vm_inspect`, `unraid_vm_start`, `unraid_vm_stop`, `unraid_vm_pause`, `unraid_vm_resume`, `unraid_vm_force_stop`, `unraid_vm_reboot` |
| Array | `unraid_array_status`, `unraid_array_start`, `unraid_array_stop`, `unraid_parity_status`, `unraid_parity_start`, `unraid_parity_pause`, `unraid_parity_resume`, `unraid_parity_cancel` |
| Disks | `unraid_disk_list`, `unraid_disk_details` |
| Shares | `unraid_share_list`, `unraid_share_details`, `unraid_share_update` |
| System | `unraid_system_info`, `unraid_system_metrics`, `unraid_service_list`, `unraid_system_reboot`, `unraid_system_shutdown` |
| Notifications | `unraid_notification_list`, `unraid_notification_create`, `unraid_notification_archive`, `unraid_notification_delete` |
| Network | `unraid_network_info` |
| Users | `unraid_user_me` |
| Logs | `unraid_syslog` |

`unraid_ca_update` and `unraid_ca_remove` act on an installed app, so their `name` is the container's name from the Docker tab, not the app's name in the catalog. Update keeps the configuration saved on the server and restores the running or stopped state; remove deletes the container and leaves appdata, volumes, the image and the template alone. Both take `dryRun`.

The six plugin tools manage Unraid `.plg` plugins through Unraid's own plugin manager. Installing one runs vendor code as root, checking for an update downloads a plugin file and stages it, and removing one runs the plugin's removal script, which may take its data with it. All four mutating tools take `dryRun`.

Tools use the gateway's 30-key `resource:action` permission matrix configured from the Unraid WebGUI. Health requires no permission.

## Links

- [GitHub](https://github.com/emaspa/unraidclaw)
- [Issues](https://github.com/emaspa/unraidclaw/issues)
- [Unraid Community Apps](https://unraid.net/community/apps)

## Gateway MCP mode

The gateway has an optional MCP endpoint at `/mcp` that serves the same 55 tools to MCP clients. It is off by default and is switched on with **Enable MCP** in the gateway's Settings tab. This plugin does not use it: OpenClaw keeps calling `/api/*` whether MCP is on or off. The tool definitions in this package are shared with the gateway through the `unraidclaw/tools` export, so OpenClaw, MCP and the standalone CLI use the same tools and the `READ_ONLY` set exported by `src/registry.ts`. The CLI is the separate `unraidclaw-cli` package, with command `unraidclaw`; it is not yet published to npm. See the [CLI guide](../cli/README.md). See the [repository README](https://github.com/emaspa/unraidclaw#mcp) for MCP client setup.

## License

MIT
