---
name: unraidclaw
description: Manage your Unraid server through AI agents - 60 tools for Docker, Community Applications, container settings, Unraid plugins, VMs, array, shares, system, notifications, and more with permission control.
---

# UnraidClaw

Manage your Unraid server through AI agents with full permission control.

## What it does

UnraidClaw gives AI agents 60 tools across 14 categories to monitor and manage an Unraid server:

- **Docker** - List, inspect, start, stop, restart, pause, unpause, remove, and create containers, list and prune unused images, and check which containers have an update
- **Community Applications** - Search the CA catalog, read an app's template, install an app as a container, update an installed app to a newer image, and remove one
- **Container Settings** - Read an installed container's saved settings and change them, rebuilding the container the way the Docker tab does
- **Plugins** - List and inspect installed .plg plugins, install one from a URL, check for updates, update, and remove
- **VMs** - List, inspect, start, stop, force-stop, pause, resume, and reboot virtual machines
- **Array** - View array status, start/stop array, run parity checks
- **Disks** - List array data and parity disks, view temperature, status and available disk usage
- **Shares** - List shares, view details, update share settings (allocator, floor, split level, comment)
- **System** - System info, CPU/memory/uptime, list services, reboot, shutdown
- **Notifications** - List, create, archive, and delete notifications
- **Network** - View network interfaces and configuration
- **Users** - View current user info
- **Logs** - Read syslog entries
- **Health** - Server health check

Tools use a 32-key permission matrix (resource:action) configurable from the Unraid WebGUI; health requires no permission. Activity logging excludes the public health probe, successful MCP handshakes and MCP GET/DELETE responses with status 405. The gateway also has an optional MCP endpoint, off by default, that exposes the same tools to MCP clients; this plugin does not use it.

## Updating and removing an installed app

`unraid_ca_update` and `unraid_ca_remove` take the name of the installed container, the one on the Docker tab. That is often not the app's name in the Community Applications catalog, so call `unraid_docker_list` and use the name you find there. Use the installed container name, not a name inferred from the catalog.

Update keeps the configuration saved on the server, including anything the user changed in the WebGUI after installing, and puts the app back in the state it was in: running if it was running, stopped if it was stopped. Volumes the container has that its template does not mention are reattached, so the replacement uses the same volume data. It never deletes the old image and never touches appdata. If the pull fails the app keeps running on the image it has. An app that is paused or restarting is refused rather than updated into a state nobody asked for.

Remove deletes the container only. Appdata, Docker volumes, the image and the saved template all stay, so the app can be recreated with the same settings. Say that when the user asks whether their data is safe, and do not offer to delete any of it, because these tools cannot.

Both take `dryRun: true`. Use it first for a removal, and read the result back to the user before doing it for real.

## Changing an installed container's settings

To change how an installed container runs, such as a port, a path, a variable, a device, its network or fixed IP, privileged mode or Extra Parameters, use `unraid_template_edit` rather than removing and recreating the container. It needs the `template:update` permission, which the owner grants separately; if it is refused with 403, say so rather than working around it. Call `unraid_template_get` first to see what the template has, and use the installed container name from `unraid_docker_list`.

Name only what should change: settings and entries the request leaves out are kept as they are. An entry is found by its type and target, plus protocol for a port, so an entry that does not exist yet is added. To change a device, pass the current one as `replaces`.

Always run it with `dryRun: true` first. Show the user the changes and the command, and ask before running it for real. If the rebuilt container does not start or stops within a few seconds, the original comes back unchanged and the error carries the new container's last log lines. Read them, explain what went wrong, and propose a corrected edit.

This tool changes settings, not the app version, unless you pass `pull: true`: then it pulls the newest image for the tag and rebuilds on it. Use `unraid_ca_update` to update an app first; when it refuses because the container is privileged or has Extra Parameters or devices, update it with `unraid_template_edit` and `pull: true` and nothing else. Changing `Repository` to another tag pulls that tag.

`ExtraParams` and `PostArgs` take only letters, digits, `: . , / + = _ -` and single spaces, because Unraid hands them to the shell unescaped.

## Creating a container by hand

`unraid_docker_create` takes `image` plus optional `name`, `ports`, `volumes`, `env`, `restart` and `network`. Six more fields match the advanced settings of Unraid's container form and are saved to the container's template, so the Docker tab shows them:

- `extraArgs` is Extra Parameters: docker run options, space separated, such as `--gpus all`, `--cap-add=SYS_ADMIN`, `--memory=8g` or `--hostname=media`. Put the network in `network`, not here.
- `postArgs` is Post Arguments: the command appended after the image, such as `--config /config/app.yml`.
- `staticIp` is a fixed IPv4 or IPv6 address. Docker only accepts it on a macvlan, ipvlan or custom bridge network, so pass `network` too; it is rejected on bridge, host and none.
- `privileged` is a boolean and defaults to false. Say so to the user before turning it on, since it gives the container full host access.
- `cpuset` pins CPUs, as `--cpuset-cpus` reads it, for example `0-3,8`.
- `devices` lists host devices, as `--device` reads them, for example `["/dev/dri"]` for hardware transcoding.

The two free-form fields accept only letters, digits, `: . , / + = _ -` and single spaces, because Unraid passes them to the shell unescaped when it rebuilds a container. Quotes and shell characters are rejected before docker runs. A container created with any of these settings in effect cannot later be rebuilt by `unraid_ca_update`; tell the user to update it from the Docker tab.

## Cleaning up images and checking for updates

`unraid_docker_images` lists every image with the containers that use it, running or stopped, and marks it `dangling` (no tag) or `unused` (no container references it). The totals give how many bytes dangling and unused images take.

`unraid_docker_prune_images` removes images no container references. The default `mode` is `dangling`, which only removes untagged leftovers and is the safe choice. `mode: "unused"` also removes tagged images no container uses; an app reinstalled later then has to pull its image again, so say so to the user. `olderThanHours` keeps recent images. Always call it with `dryRun: true` first, show the user the images and `reclaimableBytes`, and only then run it for real. The real run removes exactly the listed images and reports `removed`, `failed` and `verified`. It needs `docker:delete`.

`unraid_docker_update_status` says which containers have an image update, from the cache Unraid's Docker tab writes when it checks for updates. It never pulls or contacts a registry. Read `cache.modifiedAt` and `cache.ageSeconds` and tell the user how old the answer is; `updateAvailable: "unknown"` means Unraid has no usable entry for that image. To refresh it, the user clicks Check for Updates on the Docker tab. To apply an update, use `unraid_ca_update`, or `unraid_template_edit` with `pull: true` for containers it refuses.

## Plugins

Unraid plugins are .plg files that install files and run scripts on the server itself. They are not Docker containers. Some are listed in Community Applications, but these tools manage them directly without CA. Someone asking to install an app almost always means a container, so reach for `unraid_ca_install`. Use `unraid_plugin_install` only when they give you a .plg URL or name a plugin such as Unassigned Devices.

A .plg file is an installer Unraid runs as root, so installing one from a URL runs whatever code that URL serves. Install only from a URL the user gave you or a source they trust, and show them the dry run first. Every mutating plugin tool takes `dryRun`, which returns the plan and touches nothing.

Updating is two steps. `unraid_plugin_check_updates` downloads the plugin's published version and stages it; `unraid_plugin_update` installs what was staged. The check is not a read-only lookup: it arms an update the Unraid WebGUI will also offer. Update verifies afterwards that the installed version changed, so a result without `verified: true` is not a completed update.

Removal runs the plugin's own removal script. Some plugins keep their configuration and data, others delete it. Tell the user that before removing anything rather than promising their data survives.

OS plugins are protected from mutation. UnraidClaw can list, inspect and check itself, but cannot install over, update or remove itself through this API because its scripts stop the server handling the request. Use the Unraid WebGUI or Unraid's `plugin` command for self-management. The `unraidclaw` CLI uses the same API and cannot bypass this restriction.

## Requirements

- **Unraid 7.0.0+** with the [UnraidClaw plugin](https://github.com/emaspa/unraidclaw) installed
- An API key generated from the UnraidClaw settings page

## Configuration

| Field | Description |
|-------|-------------|
| `serverUrl` | URL of your UnraidClaw server (e.g. `https://<home-server>:9876`) |
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
