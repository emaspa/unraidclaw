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

UnraidClaw sits between AI agents and your Unraid server, providing a unified REST API with fine-grained access control. It combines Unraid's GraphQL API with direct system integration (CLI commands for parity checks, reboot/shutdown, and syslog; filesystem operations for share config editing and notification management; network introspection via `ip`) to expose capabilities that no single Unraid API covers. Every call is authenticated, authorized against a configurable permission matrix, and logged.

## Features

- **43 tools** across 11 categories: Docker, VMs, Array, Disks, Shares, System, Notifications, Network, Users, Logs
- **21 permission keys** in a resource:action matrix, configurable from the WebGUI
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

1. Go to **Settings > UnraidClaw** in the Unraid WebGUI
2. Generate an API key (it's hashed with SHA-256; save it, it won't be shown again)
3. Configure permissions on the **Permissions** tab
4. Set Service to **Enabled** and click Apply

The server starts on port `9876` over HTTPS by default. A self-signed TLS certificate is auto-generated on first start.

## API

All endpoints return a consistent envelope:

```json
{
  "ok": true,
  "data": { ... }
}
```

Authentication via `Authorization: Bearer <api-key>` header.

### Endpoints

| Category | Method | Endpoint | Permission |
|----------|--------|----------|------------|
| **Health** | GET | `/api/health` | none |
| **Docker** | GET | `/api/docker` | `docker:read` |
| | GET | `/api/docker/:id` | `docker:read` |
| | GET | `/api/docker/:id/logs` | `docker:read` |
| | POST | `/api/docker/:id/:action` | `docker:update` |
| | DELETE | `/api/docker/:id` | `docker:delete` |
| **VMs** | GET | `/api/vms` | `vms:read` |
| | GET | `/api/vms/:id` | `vms:read` |
| | POST | `/api/vms/:id/:action` | `vms:update` |
| | DELETE | `/api/vms/:id` | `vms:delete` |
| **Array** | GET | `/api/array` | `array:read` |
| | GET | `/api/array/parity` | `array:read` |
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

### Docker actions

`POST /api/docker/:id/:action` where action is one of: `start`, `stop`, `restart`, `pause`, `unpause`

### VM actions

`POST /api/vms/:id/:action` where action is one of: `start`, `stop`, `force-stop`, `pause`, `resume`, `reboot`

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

The [OpenClaw](https://github.com/openclaw/openclaw) plugin exposes all 43 tools to any AI agent that supports the OpenClaw protocol.

### Install

```bash
openclaw plugins install unraidclaw
```

### Configure

Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
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

Set `tlsSkipVerify: true` when using the auto-generated self-signed certificate.

### Tools

| Category | Tools |
|----------|-------|
| Health | `unraid_health_check` |
| Docker | `unraid_docker_list`, `unraid_docker_inspect`, `unraid_docker_logs`, `unraid_docker_start`, `unraid_docker_stop`, `unraid_docker_restart`, `unraid_docker_pause`, `unraid_docker_unpause`, `unraid_docker_remove` |
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
| Docker | `docker:read`, `docker:update`, `docker:delete` |
| VMs | `vms:read`, `vms:update`, `vms:delete` |
| Array & Storage | `array:read`, `array:update`, `disk:read`, `share:read`, `share:update` |
| System | `info:read`, `os:update`, `services:read` |
| Notifications | `notification:read`, `notification:create`, `notification:update`, `notification:delete` |
| Network | `network:read` |
| Users | `me:read` |
| Logs | `logs:read` |

The WebGUI includes presets: **Read Only**, **Docker Manager**, **VM Manager**, **Full Admin**, and **None**.

## Architecture

```
                                                        GraphQL ──> Unraid API
                                                       /            (Docker, VMs, Disks, ...)
┌─────────────┐     HTTPS      ┌──────────────────┐──+
│  AI Agent   │ ──────────────> │   UnraidClaw     │   \
│  (OpenClaw) │  Bearer token   │   (Fastify)      │    CLI ──────> mdcmd, reboot, ip, ...
└─────────────┘                 │                  │   /
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

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Type check
pnpm typecheck

# Build individual packages
pnpm build:shared
pnpm build:server
pnpm build:openclaw
```

## Security

- API keys are hashed with SHA-256 before storage; the plaintext key is never persisted
- All requests require authentication via `Authorization: Bearer` header
- Every API call is checked against the permission matrix before execution
- Activity logging records all requests with timestamps, endpoints, and results
- HTTPS with auto-generated EC (prime256v1) certificates, 10-year validity
- The server runs locally on your Unraid box, no cloud dependencies

## License

MIT
