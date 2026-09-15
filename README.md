<p align="center">
  <img src="packages/unraid-plugin/src/usr/local/emhttp/plugins/unraidclaw/unraidclaw.png" width="96" alt="UnraidClaw logo" />
</p>

<h1 align="center">UnraidClaw</h1>

<p align="center">
  AI Agent Gateway for Unraid. Permission-enforcing REST API that lets AI agents manage your server.
</p>

<p align="center">
  <a href="https://github.com/emaspa/unraidclaw/releases"><img src="https://img.shields.io/github/v/release/emaspa/unraidclaw" alt="Release" /></a>
  <a href="https://www.npmjs.com/package/unraidclaw"><img src="https://img.shields.io/npm/v/unraidclaw" alt="npm" /></a>
  <img src="https://img.shields.io/badge/unraid-7.0%2B-orange" alt="Unraid 7.0+" />
  <img src="https://img.shields.io/badge/node-22%2B-green" alt="Node 22+" />
</p>

---

UnraidClaw sits between AI agents and your Unraid servers, providing a unified REST API with fine-grained access control. It combines Unraid's GraphQL API with direct system integration (CLI commands for parity checks, reboot/shutdown, and syslog; filesystem operations for share config editing and notification management; network introspection via `ip`) to expose capabilities that no single Unraid API covers. Every call is authenticated, authorized against a configurable permission matrix, and logged.

## Features

- **55 tools** across 13 categories: Health, Docker, Community Applications, Plugins, VMs, Array, Disks, Shares, System, Notifications, Network, Users, Logs
- **30 permission keys** in a resource:action matrix, configurable from the WebGUI
- **HTTPS** with auto-generated self-signed TLS certificate
- **SHA-256 API key** authentication
- **Activity logging** with JSONL format, filter, and search
- **OpenClaw plugin** available on npm (`openclaw plugins install unraidclaw`)
- **Single-file server**, no `node_modules` needed on Unraid

## Requirements

- **Unraid 7.0.0+** (Node.js 22 is built-in)

## Installation

### From Community Applications

Search for **UnraidClaw** in the Unraid CA store and click Install.

### Manual install

```bash
# Download and install the plugin
plugin install https://raw.githubusercontent.com/emaspa/unraidclaw/main/packages/unraid-plugin/unraidclaw.plg
```

### Setup

1. Go to **Settings > Management Access** in the Unraid WebGUI, scroll to the API section, and copy your Unraid API key (must have **ADMIN** role)
2. Go to **Settings > UnraidClaw**, paste the Unraid API key into the **Unraid API Key** field
3. Generate an UnraidClaw API key (it's hashed with SHA-256; save it, it won't be shown again)
4. Configure permissions on the **Permissions** tab
5. Set Service to **Enabled** and click Apply

The server starts on port `9876` over HTTPS by default. A self-signed TLS certificate is auto-generated on first start.

## API

All endpoints return a consistent envelope:

```json
{
  "ok": true,
  "data": { ... }
}
```

Authentication via `x-api-key: <api-key>` header.

### Endpoints

| Category | Method | Endpoint | Permission |
|----------|--------|----------|------------|
| **Health** | GET | `/api/health` | none |
| **Docker** | GET | `/api/docker/containers` | `docker:read` |
| | GET | `/api/docker/containers/:id` | `docker:read` |
| | GET | `/api/docker/containers/:id/logs` | `docker:read` |
| | POST | `/api/docker/containers` | `docker:create` |
| | POST | `/api/docker/containers/:id/:action` | `docker:update` |
| | DELETE | `/api/docker/containers/:id` | `docker:delete` |
| **Community Apps** | GET | `/api/ca/search?q=` | `ca:read` |
| | GET | `/api/ca/app/:name` | `ca:read` |
| | POST | `/api/ca/app/:name/install` | `ca:create` |
| | POST | `/api/ca/app/:name/update` | `ca:update` |
| | POST | `/api/ca/app/:name/remove` | `ca:delete` |
| **Plugins** | GET | `/api/plugins` | `plugins:read` |
| | GET | `/api/plugins/:file` | `plugins:read` |
| | POST | `/api/plugins/install` | `plugins:create` |
| | POST | `/api/plugins/:file/check` | `plugins:update` |
| | POST | `/api/plugins/:file/update` | `plugins:update` |
| | POST | `/api/plugins/:file/remove` | `plugins:delete` |
| **VMs** | GET | `/api/vms` | `vms:read` |
| | GET | `/api/vms/:id` | `vms:read` |
| | POST | `/api/vms/:id/:action` | `vms:update` |
| | DELETE | `/api/vms/:id` | `vms:delete` |
| **Array** | GET | `/api/array/status` | `array:read` |
| | GET | `/api/array/parity/status` | `array:read` |
| | POST | `/api/array/start` | `array:update` |
| | POST | `/api/array/stop` | `array:update` |
| | POST | `/api/array/parity/start` | `array:update` |
| | POST | `/api/array/parity/pause` | `array:update` |
| | POST | `/api/array/parity/resume` | `array:update` |
| | POST | `/api/array/parity/cancel` | `array:update` |
| **Disks** | GET | `/api/disks` | `disk:read` |
| | GET | `/api/disks/:id` | `disk:read` |
| **Shares** | GET | `/api/shares` | `share:read` |
| | GET | `/api/shares/:name` | `share:read` |
| | PATCH | `/api/shares/:name` | `share:update` |
| **System** | GET | `/api/system/info` | `info:read` |
| | GET | `/api/system/metrics` | `info:read` |
| | GET | `/api/system/services` | `services:read` |
| | POST | `/api/system/reboot` | `os:update` |
| | POST | `/api/system/shutdown` | `os:update` |
| **Notifications** | GET | `/api/notifications` | `notification:read` |
| | GET | `/api/notifications/overview` | `notification:read` |
| | POST | `/api/notifications` | `notification:create` |
| | POST | `/api/notifications/:id/archive` | `notification:update` |
| | DELETE | `/api/notifications/:id` | `notification:delete` |
| **Network** | GET | `/api/network` | `network:read` |
| **Users** | GET | `/api/users/me` | `me:read` |
| **Logs** | GET | `/api/logs/syslog` | `logs:read` |

### Docker create

`POST /api/docker/containers` accepts:

```json
{
  "image": "vikunja/vikunja:latest",
  "name": "vikunja",
  "ports": ["3456:3456"],
  "volumes": ["/mnt/cache/appdata/vikunja:/app/vikunja/files"],
  "env": ["VIKUNJA_SERVICE_TIMEZONE=Europe/London"],
  "restart": "unless-stopped",
  "network": "bridge",
  "icon": "https://example.com/icon.png",
  "webui": "http://[IP]:[PORT:3456]/"
}
```

Only `image` is required. The container is started immediately and an Unraid dockerMan XML template is created so it appears in the Docker tab.

### Community Applications

The CA endpoints search the public catalog, inspect templates, and install apps. Update and removal use the installed container's saved template, not current catalog defaults.

`GET /api/ca/search?q=plex` matches every query word against names, images, maintainers and descriptions. Add `includePlugins=true` or `includeDeprecated=true` to include entries hidden by default.

`GET /api/ca/app/:name` returns template details, configurable ports, volumes and environment variables, required fields without defaults, and installation blockers. If several templates share a name, the API returns 409 with the candidates. Use `?repo=linuxserver` to select a repository.

#### Installing an app

`POST /api/ca/app/Jellyfin/install` accepts template overrides and an optional container name:

```json
{
  "repo": "linuxserver",
  "name": "jellyfin",
  "overrides": {
    "/config": "/mnt/user/appdata/jellyfin",
    "/data/tvshows": "/mnt/user/media/tv",
    "/data/movies": "/mnt/user/media/movies",
    "PUID": "99"
  },
  "dryRun": true
}
```

Override keys are the field's display name or container-side target. Unknown keys and missing required values return 400. Review the dry-run template and command preview, then set `dryRun` to `false` to install. The app appears on Unraid's Docker tab with its template, icon and WebUI link. The command preview omits some values Unraid adds, including host settings and template labels.

Installation returns 422 for unsupported templates: Extra Parameters, Post Arguments, privileged mode, device passthrough, custom networks, Tailscale, pinned MAC addresses, legacy configuration, unknown field types, or an incompatible Unraid version. Deprecated, blacklisted and `.plg` entries are also refused. Use the WebGUI for these cases.

Host paths are used as written. Supply overrides if you relocated appdata; UnraidClaw does not apply CA's path-rewriting rules. A missing `/mnt` pool or share root returns 400 rather than creating a directory on Unraid's RAM filesystem.

An existing container or `my-<name>.xml` template returns 409 and is not overwritten. A failed install keeps its template so you can inspect it and finish from the Docker tab.

#### Updating and removing an installed app

These endpoints take the **installed container name** from the Docker tab, which may differ from the catalog name:

- `POST /api/ca/app/:name/update`
- `POST /api/ca/app/:name/remove`

Both accept `{"dryRun": true}`. A preview reads the installed configuration but does not pull images or change containers. The container must have a matching saved template and Unraid's `net.unraid.docker.managed=dockerman` label. Concurrent actions against the same container return 409.

Update pulls the current image tag and preserves saved ports, paths, variables and network mode, plus the container's restart policy, pids limit and attached Docker volumes. Running apps return to running; stopped apps remain stopped. If the image has not changed, no replacement is created.

The replacement is created before stopping the old container. UnraidClaw swaps their names, starts the replacement when needed, verifies its state, then removes the old container without deleting its image or volumes. A failed replacement triggers a rollback. If rollback fails, the error identifies the original container for recovery. Container rollback cannot reverse changes an updated app makes to its data.

Updates refuse paused or unstable containers and configurations they cannot reproduce, including unsupported template fields, device access, custom runtime settings and resource limits. Update previews and errors redact values marked `Mask="true"` in the saved template.

Remove deletes only the container. Appdata, Docker volumes, the image and the saved template remain. Use **Add Container** on the Docker tab to recreate it from the saved configuration.

### Plugins

The separate Plugins endpoints manage Unraid `.plg` plugins without CA. List and inspect require `plugins:read`; install requires `plugins:create`; check and update require `plugins:update`; removal requires `plugins:delete`. All four permissions default to off.

Install takes an explicit public HTTPS URL ending in `.plg`. Downloads have size and time limits; private addresses, unsafe URLs and redirects to them are refused. The plugin manager runs the downloaded installer as root, so use sources you trust.

Check and update are separate operations. `POST /api/plugins/:file/check` downloads the published definition and stages it in `/tmp/plugins`. `POST /api/plugins/:file/update` applies that staged version. A check changes the staged files even though it does not install anything. Older, mismatched and unregistered one-shot definitions are refused as updates.

`POST /api/plugins/:file/remove` runs the plugin's own uninstall scripts. Those scripts may delete configuration or data; unlike CA container removal, data preservation is not guaranteed.

Every mutating Plugins endpoint accepts `{"dryRun": true}` to return a plan without downloading, writing or executing scripts. Plugin names accept the `.plg` suffix or omit it. OS plugins are protected. UnraidClaw can list, inspect and check itself, but self-install, self-update and self-removal require the WebGUI or CLI because they stop the API server.

### Docker actions

`POST /api/docker/containers/:id/:action` where action is one of: `start`, `stop`, `restart`, `pause`, `unpause`

### VM actions

`POST /api/vms/:id/:action` where action is one of: `start`, `stop`, `force-stop`, `pause`, `resume`, `reboot`, `reset`

### Share update

`PATCH /api/shares/:name` accepts:

```json
{
  "comment": "My share description",
  "allocator": "highwater",
  "splitLevel": "1",
  "floor": "0"
}
```

## OpenClaw Plugin

The [OpenClaw](https://github.com/openclaw/openclaw) plugin exposes all 55 tools to any AI agent that supports the OpenClaw protocol.

### Install

```bash
npm pack unraidclaw && openclaw plugins install unraidclaw-*.tgz && rm unraidclaw-*.tgz
```

### Update

```bash
rm -rf ~/.openclaw/extensions/unraidclaw && npm pack unraidclaw && openclaw plugins install unraidclaw-*.tgz && rm unraidclaw-*.tgz
```

### Configure

Edit `~/.openclaw/openclaw.json`:

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
            {
              "name": "home",
              "serverUrl": "https://192.168.1.100:9876",
              "apiKey": "...",
              "tlsSkipVerify": true,
              "default": true
            },
            {
              "name": "work",
              "serverUrl": "https://10.0.0.50:9876",
              "apiKey": "..."
            }
          ]
        }
      }
    }
  }
}
```

With multi-server, every tool accepts an optional `server` parameter (e.g. `unraid_docker_list(server: "work")`). If omitted, the default server is used.

Set `tlsSkipVerify: true` when using the auto-generated self-signed certificate.

**Keeping the API key out of the config file:** you don't have to hard-code the key in `openclaw.json`. OpenClaw expands `${VAR}` references from the environment at config-load time, so you can point `apiKey` at an environment variable:

```json
"apiKey": "${UNRAID_API_KEY}"
```

The secret then lives in your environment (shell, systemd `EnvironmentFile`, or container secret) and never in `openclaw.json`. This works for `servers[].apiKey` in the multi-server form too.

**Provider-backed secrets (`SecretRef`):** `apiKey` also accepts an OpenClaw `SecretRef` object, so the key can come from one of your configured secret providers (file, env, exec). OpenClaw resolves it before the plugin loads — the plugin only ever sees the resolved string:

```json
"apiKey": { "source": "file", "provider": "default", "id": "/unraidclaw_key" }
```

`source` is one of `file`, `env`, or `exec`; `provider` names a provider from your `secrets.providers` config; `id` is the lookup key. This also works per-server on `servers[].apiKey`.

### Tools

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

## Permissions

Permissions use a `resource:action` format. Configure them from the WebGUI Permissions tab or edit `/boot/config/plugins/unraidclaw/permissions.json` directly.

| Category | Permissions |
|----------|------------|
| Docker | `docker:read`, `docker:create`, `docker:update`, `docker:delete` |
| Community Apps | `ca:read`, `ca:create`, `ca:update`, `ca:delete` |
| Plugins | `plugins:read`, `plugins:create`, `plugins:update`, `plugins:delete` |
| VMs | `vms:read`, `vms:update`, `vms:delete` |
| Array & Storage | `array:read`, `array:update`, `disk:read`, `share:read`, `share:update` |
| System | `info:read`, `os:update`, `services:read` |
| Notifications | `notification:read`, `notification:create`, `notification:update`, `notification:delete` |
| Network | `network:read` |
| Users | `me:read` |
| Logs | `logs:read` |

The WebGUI includes **Read Only**, **Docker Manager**, **VM Manager**, **Full Admin**, and **None** presets. Docker Manager includes all four `ca:` permissions. Read Only includes `plugins:read`. Plugin write permissions must be enabled individually or through Full Admin.

## Architecture

```
                                                        GraphQL ──> Unraid API
                                                       /            (list queries, array, disks)
┌─────────────┐     HTTPS      ┌──────────────────┐──+
│  AI Agent   │ ──────────────> │   UnraidClaw     │   \
│  (OpenClaw) │   x-api-key    │   (Fastify)      │    CLI ──────> docker, virsh, mdcmd,
└─────────────┘                 │                  │   /            reboot, ip, ...
                                │  - Auth          │──+
                                │  - Permissions   │   \
                                │  - Activity Log  │    Filesystem > share configs, syslog,
                                └──────────────────┘                 notifications
```

This is a pnpm monorepo with three packages:

| Package | Description |
|---------|-------------|
| `packages/shared` | Shared TypeScript types, permission definitions, API interfaces |
| `packages/unraid-plugin/server` | Fastify REST API server, bundles to a single CJS file |
| `packages/openclaw-plugin` | OpenClaw plugin, bundles to a single ESM file, published to npm as `unraidclaw` |

## Security

- API keys are hashed with SHA-256 before storage; the plaintext key is never persisted
- All requests require authentication via `x-api-key` header
- Every API call is checked against the permission matrix before execution
- Activity logging records all requests with timestamps, endpoints, and results
- HTTPS with auto-generated EC (prime256v1) certificates, 10-year validity
- The server runs locally on your Unraid box, no cloud dependencies

## License

MIT
