**UnraidClaw** is a permission-enforcing REST API gateway that lets AI agents manage your Unraid server.

It exposes Docker, VMs, Community Applications, Plugins, Array, Disks, Shares, System, Notifications, Network, and Logs management with fine-grained access control, so you can safely grant an AI tool only what it needs. Requests reach Unraid through its GraphQL API, the docker and plugin CLIs, and the filesystem.

Features:
- Full resource:action permission matrix configurable from the WebGUI
- SHA-256 API key authentication
- Activity logging with JSONL format
- Requires Node.js 22+ (built-in on Unraid 7.x)
