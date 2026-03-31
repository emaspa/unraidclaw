---
name: unraidclaw
description: Manage your Unraid server through AI agents - 43 tools for Docker, VMs, array, shares, system, notifications, and more with permission control.
---

# UnraidClaw

Manage your Unraid server through AI agents with full permission control.

## What it does

UnraidClaw gives AI agents 43 tools across 11 categories to monitor and manage an Unraid server:

- **Docker** - List, inspect, start, stop, restart, pause, unpause, remove, and create containers
- **VMs** - List, inspect, start, stop, force-stop, pause, resume, reboot, reset, and remove virtual machines
- **Array** - View array status, start/stop array, run parity checks
- **Disks** - List disks, view SMART data and individual disk details
- **Shares** - List shares, view details, update share settings (allocator, floor, split level, comment)
- **System** - System info, CPU/memory/uptime, list services, reboot, shutdown
- **Notifications** - List, create, archive, and delete notifications
- **Network** - View network interfaces and configuration
- **Users** - View current user info
- **Logs** - Read syslog entries
- **Health** - Server health check

Every tool is gated by a 22-key permission matrix (resource:action) configurable from the Unraid WebGUI. The server logs all API activity.

## Requirements

- **Unraid 6.12+** with the [UnraidClaw plugin](https://github.com/emaspa/unraidclaw) installed
- An API key generated from the UnraidClaw settings page

## Configuration

| Field | Description |
|-------|-------------|
| `serverUrl` | URL of your UnraidClaw server (e.g. `http://192.168.1.100:9876`) |
| `apiKey` | API key from the UnraidClaw settings page |
| `tlsSkipVerify` | Set to `true` for self-signed TLS certificates |

## Install

UnraidClaw is an OpenClaw **plugin** (not a skill). Install from npm:

```bash
npm pack unraidclaw && openclaw plugins install unraidclaw-*.tgz && rm unraidclaw-*.tgz
```

Then configure in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "unraidclaw": {
      "serverUrl": "http://YOUR_UNRAID_IP:9876",
      "apiKey": "YOUR_API_KEY"
    }
  }
}
```

## Examples

- "List all running Docker containers"
- "Stop the plex container"
- "What's the array status?"
- "Show me disk temperatures"
- "Create a new nginx container with port 8080"
- "Check parity status"
- "Show recent notifications"
- "Reboot the server"

## Links

- [GitHub](https://github.com/emaspa/unraidclaw)
- [npm](https://www.npmjs.com/package/unraidclaw)
- [Unraid Community Apps](https://unraid.net/community/apps)
