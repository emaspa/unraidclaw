**UnraidClaw** is a permission-enforcing REST API gateway that lets AI agents manage your Unraid server.

It proxies requests to Unraid's built-in GraphQL API with fine-grained access control, so you can safely expose Docker, VMs, Array, Shares, System, Notifications, and Network management to AI tools.

Features:
- Full resource:action permission matrix configurable from the WebGUI
- SHA-256 API key authentication
- Activity logging with JSONL format
- Requires Node.js 22+ (built-in on Unraid 7.x)
