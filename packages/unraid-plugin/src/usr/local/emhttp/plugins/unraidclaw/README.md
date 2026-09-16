**UnraidClaw** is a permission-enforcing REST API gateway that lets AI agents manage your Unraid server.

It exposes Docker, VMs, Community Applications, Plugins, Array, Disks, Shares, System, Notifications, Network, and Logs management with fine-grained access control, so you can safely grant an AI tool only what it needs. Requests reach Unraid through its GraphQL API, the docker and plugin CLIs, and the filesystem.

Features:
- Full resource:action permission matrix configurable from the WebGUI
- SHA-256 API key authentication
- Activity logging with JSONL format
- HTTPS with a self-signed certificate that names the server's host name and addresses
- Optional MCP endpoint at /mcp, off by default, using the same API key and permissions
- Command-line client at /usr/local/bin/unraidclaw, using the same tools and permissions
- TLS certificate details, SHA-256 fingerprint and regeneration in Settings
- Requires Node.js 22+ (built-in on Unraid 7.x)
