---
name: unraidclaw
description: Manage your Unraid server through AI agents - 55 tools for Docker, Community Applications, Unraid plugins, VMs, array, shares, system, notifications, and more with permission control.
---

# UnraidClaw

Manage your Unraid server through AI agents with full permission control.

## What it does

UnraidClaw gives AI agents 55 tools across 13 categories to monitor and manage an Unraid server:

- **Docker** - List, inspect, start, stop, restart, pause, unpause, remove, and create containers
- **Community Applications** - Search the CA catalog, read an app's template, install an app as a container, update an installed app to a newer image, and remove one
- **Plugins** - List and inspect installed .plg plugins, install one from a URL, check for updates, update, and remove
- **VMs** - List, inspect, start, stop, force-stop, pause, resume, and reboot virtual machines
- **Array** - View array status, start/stop array, run parity checks
- **Disks** - List disks, view SMART data and individual disk details
- **Shares** - List shares, view details, update share settings (allocator, floor, split level, comment)
- **System** - System info, CPU/memory/uptime, list services, reboot, shutdown
- **Notifications** - List, create, archive, and delete notifications
- **Network** - View network interfaces and configuration
- **Users** - View current user info
- **Logs** - Read syslog entries
- **Health** - Server health check

Every tool is gated by a 30-key permission matrix (resource:action) configurable from the Unraid WebGUI. The server logs all API activity. The gateway also has an optional MCP endpoint, off by default, that exposes the same tools to MCP clients; this plugin does not use it.

## Updating and removing an installed app

`unraid_ca_update` and `unraid_ca_remove` take the name of the installed container, the one on the Docker tab. That is often not the app's name in the Community Applications catalog, so call `unraid_docker_list` and use the name you find there. Use the installed container name, not a name inferred from the catalog.

Update keeps the configuration saved on the server, including anything the user changed in the WebGUI after installing, and puts the app back in the state it was in: running if it was running, stopped if it was stopped. Volumes the container has that its template does not mention are reattached, so the replacement uses the same volume data. It never deletes the old image and never touches appdata. If the pull fails the app keeps running on the image it has. An app that is paused or restarting is refused rather than updated into a state nobody asked for.

Remove deletes the container only. Appdata, Docker volumes, the image and the saved template all stay, so the app can be recreated with the same settings. Say that when the user asks whether their data is safe, and do not offer to delete any of it, because these tools cannot.

Both take `dryRun: true`. Use it first for a removal, and read the result back to the user before doing it for real.

## Plugins

Unraid plugins are .plg files that install files and run scripts on the server itself. They are not Docker containers. Some are listed in Community Applications, but these tools manage them directly without CA. Someone asking to install an app almost always means a container, so reach for `unraid_ca_install`. Use `unraid_plugin_install` only when they give you a .plg URL or name a plugin such as Unassigned Devices.

A .plg file is an installer Unraid runs as root, so installing one from a URL runs whatever code that URL serves. Install only from a URL the user gave you or a source they trust, and show them the dry run first. Every mutating tool takes `dryRun`, which returns the plan and touches nothing.

Updating is two steps. `unraid_plugin_check_updates` downloads the plugin's published version and stages it; `unraid_plugin_update` installs what was staged. The check is not a read-only lookup: it arms an update the Unraid WebGUI will also offer. Update verifies afterwards that the installed version changed, so a result without `verified: true` is not a completed update.

Removal runs the plugin's own removal script. Some plugins keep their configuration and data, others delete it. Tell the user that before removing anything rather than promising their data survives.

OS plugins are protected from mutation. UnraidClaw can list, inspect and check itself, but cannot install over, update or remove itself through this API because its scripts stop the server handling the request. Use the Unraid WebGUI or CLI for self-management.

## Requirements

- **Unraid 7.0.0+** with the [UnraidClaw plugin](https://github.com/emaspa/unraidclaw) installed
- An API key generated from the UnraidClaw settings page

## Configuration

| Field | Description |
|-------|-------------|
| `serverUrl` | URL of your UnraidClaw server (e.g. `https://192.168.1.100:9876`) |
| `apiKey` | API key from the UnraidClaw settings page |
| `tlsSkipVerify` | Set to `true` to accept the gateway's self-signed certificate. This disables certificate verification for that server |

## Install

UnraidClaw is an OpenClaw **plugin** (not a skill). Install it from ClawHub:

```bash
openclaw plugins install clawhub:unraidclaw --accept-capabilities
```

It is also on npm, which needs `--force` because the source is outside ClawHub:

```bash
openclaw plugins install unraidclaw --force --accept-capabilities
```

Then configure in `~/.openclaw/openclaw.json`:

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

## Examples

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
- "Show recent notifications"
- "Reboot the server"

## Links

- [GitHub](https://github.com/emaspa/unraidclaw)
- [npm](https://www.npmjs.com/package/unraidclaw)
- [Unraid Community Apps](https://unraid.net/community/apps)
