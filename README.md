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

UnraidClaw sits between AI agents and your Unraid servers, providing a unified REST API with fine-grained access control. It combines Unraid's GraphQL API with direct system integration (CLI commands for parity checks, reboot/shutdown, and syslog; filesystem operations for share config editing and notification management; network introspection via `ip`) to expose capabilities that no single Unraid API covers. Every call is authenticated, authorized against a configurable permission matrix, and logged. An optional MCP endpoint, off by default, exposes the same tools to MCP clients under the same permissions.

## Features

- **55 tools** across 13 categories: Health, Docker, Community Applications, Plugins, VMs, Array, Disks, Shares, System, Notifications, Network, Users, Logs
- **30 permission keys** in a resource:action matrix, configurable from the WebGUI
- **HTTPS** with auto-generated self-signed TLS certificate
- **SHA-256 API key** authentication
- **Activity logging** with JSONL format, filter, and search
- **OpenClaw plugin** available on ClawHub and npm (`openclaw plugins install clawhub:unraidclaw --accept-capabilities`)
- **Optional MCP** at `/mcp` for Streamable HTTP clients, off by default, using the same API key and permissions as the REST API
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

The server starts on port `9876` over HTTPS by default. A self-signed TLS certificate is generated on first start; see [TLS certificate](#tls-certificate) for what it contains and how clients trust it.

### Settings tab

**Settings > UnraidClaw > Settings** holds the service configuration. **Apply** writes `/boot/config/plugins/unraidclaw/unraidclaw.cfg` and restarts the service, or stops it when the service is disabled.

| Row | What it does |
|-----|--------------|
| Enable Service | Starts the gateway (`SERVICE="enable"`) |
| Enable MCP | Serves MCP at `/mcp` on the same port (`MCP_ENABLED="yes"`). Off by default. See [MCP](#mcp) |
| Listen Port | Port for the REST API and MCP, `9876` by default |
| Listen Host | Bind address, `0.0.0.0` by default. An explicit address is also added to the MCP Origin allowlist |
| Unraid WebUI Port | Port of the Unraid WebGUI, used to build the GraphQL URL |
| Unraid API Key | The Unraid API key with the ADMIN role. Leave blank to keep the stored key |

The **API Key Management** section generates the UnraidClaw API key. The **TLS Certificate** section shows the current certificate's subject, subject alternative names and expiry date, warns when the certificate has no `subjectAltName`, and has a **Regenerate certificate** button. [TLS certificate](#tls-certificate) says what regenerating does and what clients must do afterwards.

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

Installation returns 422 for unsupported templates: Extra Parameters, Post Arguments, privileged mode, device passthrough, custom networks, Additional Networks, Tailscale, pinned MAC addresses, legacy configuration, unknown field types, or an incompatible Unraid version. Deprecated, blacklisted and `.plg` entries are also refused. Use the WebGUI for these cases.

Unraid 7.4 templates can set a memory limit and a list of Additional Networks. On 7.4 the limit is written into the saved template and shown in the command preview, so the container is created with it and later updates keep it. Unraid 7.0 through 7.3 do not read the new `<Memory>` template field, so a template that sets it returns 422 there instead of installing an app whose limit would never apply. The same happens when the server's version cannot be read. An unreadable limit, a nonzero limit below Docker's 6 MB minimum, or a limit above UnraidClaw's exact numeric range returns 422 before anything is written or run. Additional Networks are refused rather than dropped, because Unraid attaches them with a second `docker network connect` step that UnraidClaw does not run.

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

## MCP

MCP is off by default. In **Settings > UnraidClaw > Settings**, set **Enable MCP** to **Yes** and click **Apply**. This writes `MCP_ENABLED="yes"` to `/boot/config/plugins/unraidclaw/unraidclaw.cfg` and restarts the service. The endpoint is `https://<server>:9876/mcp`, on the same port as the REST API. While MCP is off, `/mcp` returns HTTP 404 for every method, with or without a key.

Authenticate with the UnraidClaw API key using `x-api-key: <key>` or `Authorization: Bearer <key>`; `x-api-key` takes precedence if both are sent. Query parameters cannot supply the key. Failed attempts count toward the same per-IP limit as the REST API.

For [Claude Code](https://code.claude.com/docs/en/mcp):

```bash
claude mcp add --transport http unraidclaw https://<server>:9876/mcp --header "x-api-key: <key>"
```

For clients that accept an HTTP MCP server entry:

```json
{
  "mcpServers": {
    "unraidclaw": {
      "type": "http",
      "url": "https://<server>:9876/mcp",
      "headers": {
        "x-api-key": "<key>"
      }
    }
  }
}
```

Replace the placeholders locally. The gateway's certificate is self-signed, so the client must either trust it or skip verification; see [TLS certificate](#tls-certificate).

Supported protocol versions are `2025-11-25`, `2025-06-18` and `2025-03-26`. Initialization echoes a supported version or returns the latest for an unknown version. Send `Content-Type: application/json`, `Accept: application/json, text/event-stream` and the negotiated `MCP-Protocol-Version` header. An absent version header defaults to `2025-03-26`; an unsupported value returns HTTP 400 with JSON-RPC error `-32600` listing the supported versions.

The transport uses stateless JSON responses without SSE or sessions. It supports `initialize`, `ping`, `tools/list` and `tools/call`; notifications receive HTTP 202 with an empty body. Batches are rejected with `-32600` for every version, including `2025-03-26`.

| Method | Endpoint | Availability and permissions |
|--------|----------|------------------------------|
| POST | `/mcp` | Enabled only with MCP; API key required; each tool uses its existing REST permission |
| GET, DELETE | `/mcp` | HTTP 405 when enabled |
| Any | `/mcp` | HTTP 404 when disabled |

The endpoint exposes the same 55 tools as the OpenClaw plugin, without OpenClaw's `server` argument. Read-only tools carry `readOnlyHint`; every other tool carries `destructiveHint`. Each call runs through the gateway's own `/api/` route in process, so the permission matrix, body validation, dry-run rules and blockers apply unchanged. OpenClaw keeps using `/api/*` whether MCP is on or off.

If present, `Origin` must exactly match the gateway's configured scheme and port with a loopback address, a local interface IP or the explicit **Listen Host**; other origins receive HTTP 403. The allowlist is built at startup without trusting incoming Host or forwarded headers, so a browser frontend or reverse proxy using a different public origin is rejected. Requests without an `Origin` header, which non-browser clients normally send, are accepted.

## TLS certificate

The service generates a self-signed certificate on first start and stores it as `cert.pem` and `key.pem` in `/boot/config/plugins/unraidclaw/tls`. The key is EC prime256v1 and the certificate is valid for ten years. Its `subjectAltName` names the server's host name, `<host>.local`, `localhost`, `127.0.0.1`, `::1` and the host's stable global IPv4 and IPv6 addresses. Temporary and deprecated IPv6 privacy addresses are left out because they rotate on their own.

A certificate created by an earlier version has no `subjectAltName`. It is replaced once, on the first service start after the upgrade, and the old pair is kept as `cert.pem.bak` and `key.pem.bak` in the same directory. A certificate that already has a `subjectAltName` is never replaced automatically, including when the server's addresses change. If OpenSSL is missing or generation fails, the service starts with the existing files. On a fresh install with an OpenSSL that cannot add extensions it falls back to a certificate without `subjectAltName`, and without OpenSSL at all it serves plain HTTP.

To replace a certificate whose names or addresses are out of date, open **Settings > UnraidClaw > Settings** and use the **TLS Certificate** section. It shows the certificate's subject, subject alternative names and expiry date, and warns when `subjectAltName` is missing. **Regenerate certificate** asks for confirmation, then moves the current pair to `cert.pem.bak` and `key.pem.bak` (an existing backup moves to the first free numbered suffix, such as `cert.pem.bak.1`), restarts the service so it generates a new pair, and refreshes the displayed details. If the files cannot be moved, the originals are restored and the service is not restarted. If the restart fails or produces no usable certificate, the previous pair stays available as `.bak` files. Only one regeneration runs at a time. The WebGUI reads the certificate's public details with OpenSSL and never opens the private key.

What this means for clients:

- A client that trusts the certificate can verify the server's host name or IP address against the `subjectAltName`. Node-based clients such as Claude Code can trust it with [`NODE_EXTRA_CA_CERTS`](https://nodejs.org/api/cli.html#node_extra_ca_certsfile) pointing to a local copy of `cert.pem`. After the one-time replacement or a regeneration, the client must replace its copy and restart, because the new certificate has a different key and fingerprint.
- The OpenClaw plugin accepts the self-signed certificate with `tlsSkipVerify: true`. That disables verification entirely, so it is unaffected by regeneration but also does not check which server it is talking to.
- A certificate created before this change has no alternative names until it is replaced, so strict clients cannot verify it even when they trust it. The Settings tab shows a warning in that case.

## OpenClaw Plugin

The [OpenClaw](https://github.com/openclaw/openclaw) plugin exposes all 55 tools to any AI agent that supports the OpenClaw protocol.

### Install

```bash
openclaw plugins install clawhub:unraidclaw --accept-capabilities
```

The same package is on npm. OpenClaw asks you to confirm installs from outside ClawHub, so installing from npm needs `--force`:

```bash
openclaw plugins install unraidclaw --force --accept-capabilities
```

### Update

```bash
openclaw plugins update unraidclaw --accept-capabilities
```

Then restart the gateway with `openclaw gateway restart` so it loads the new version.

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

Set `tlsSkipVerify: true` to accept the gateway's self-signed certificate. The plugin does not verify the certificate in that mode; see [TLS certificate](#tls-certificate).

**Keeping the API key out of the config file:** you don't have to hard-code the key in `openclaw.json`. OpenClaw expands `${VAR}` references from the environment at config-load time, so you can point `apiKey` at an environment variable:

```json
"apiKey": "${UNRAID_API_KEY}"
```

The secret then lives in your environment (shell, systemd `EnvironmentFile`, or container secret) and never in `openclaw.json`. This works for `servers[].apiKey` in the multi-server form too.

**Provider-backed secrets (`SecretRef`):** `apiKey` also accepts an OpenClaw `SecretRef` object, so the key can come from one of your configured secret providers (file, env, exec). OpenClaw resolves it before the plugin loads, so the plugin only ever sees the resolved string:

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
│  AI Agent   │ ─────────────> │   UnraidClaw     │   \
│  (OpenClaw  │   x-api-key    │   (Fastify)      │    CLI ──────> docker, virsh, mdcmd,
│  or MCP)    │                │                  │   /            reboot, ip, ...
└─────────────┘                │  - Auth          │──+
                               │  - Permissions   │   \
                               │  - Activity Log  │    Filesystem > share configs, syslog,
                               └──────────────────┘                 notifications
```

OpenClaw calls `/api/*` over HTTPS. MCP clients, when MCP is enabled, call `/mcp` on the same gateway. The tool definitions live once, in the openclaw-plugin package, which exports them as a transport-neutral registry (`unraidclaw/tools`, from `src/registry.ts`). The OpenClaw entry registers that registry with OpenClaw and sends HTTP requests to the gateway. The gateway's MCP adapter imports the same registry and runs each tool call through its own `/api/` route in process, so authentication, permission checks and activity logging are shared and no second network connection is made.

This is a pnpm monorepo with three packages:

| Package | Description |
|---------|-------------|
| `packages/shared` | Shared TypeScript types, permission definitions, API interfaces |
| `packages/unraid-plugin/server` | Fastify REST API and optional MCP endpoint, bundles to a single CJS file |
| `packages/openclaw-plugin` | OpenClaw plugin entry plus the transport-neutral tool registry (`unraidclaw/tools`) that the gateway's MCP adapter consumes, published to npm as `unraidclaw` |

## Security

- API keys are hashed with SHA-256 before storage; the plaintext key is never persisted
- REST requests require `x-api-key`, except the public `/api/health` probe. MCP requests accept `x-api-key` or `Authorization: Bearer` and always require a key. When MCP is off, `/mcp` does not exist
- MCP rejects any `Origin` outside an allowlist built at startup from loopback, the local interface addresses and the configured Listen Host, which blocks DNS rebinding from a browser. Requests without an `Origin` header are allowed, so for non-browser clients the API key is the only protection
- Failed authentication is limited per IP to 10 attempts per minute; REST and MCP share the counter
- Every API call, including an MCP tool call, is checked against the permission matrix before execution
- Activity logging records all requests with timestamps, endpoints, and results. An MCP tool call is logged as the `/mcp` request plus the `/api/` route it ran in process
- HTTPS uses a self-signed EC (prime256v1) certificate valid for ten years, with the server's names and stable addresses in `subjectAltName`. This lets a client that trusts the certificate verify the host name. It does not protect a client that skips verification, and a client that has not trusted it sees a warning or refuses to connect. See [TLS certificate](#tls-certificate)
- The server runs locally on your Unraid box, no cloud dependencies

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the build, test and pull-request workflow. AI agents working on this tree should read [AGENTS.md](AGENTS.md) first.

## License

MIT
