# Contributing to UnraidClaw

Thanks for helping. This page says how the project works so a change lands on the first try. Questions before you start are welcome in a GitHub issue.

UnraidClaw is a permission-enforcing REST gateway that runs on an Unraid server, plus an OpenClaw plugin that turns the gateway into tools for an AI agent. It is a pnpm monorepo with three packages: `packages/shared` (types and the permission matrix), `packages/unraid-plugin/server` (the Fastify gateway, bundled to one CommonJS file), and `packages/openclaw-plugin` (the OpenClaw plugin, bundled to an ESM entry plus a transport-neutral tool registry and published to npm as `unraidclaw`).

## What helps most

- **Bugs with a way to reproduce them.** Say what you did, what you expected, and what happened. Paste the gateway's activity log (JSONL, on the Unraid box) and the response body. State your Unraid version and the plugin version.
- **Permission and safety problems.** Anything that let an action through when it should not have, or refused one it should have allowed, is high priority. Include the permission matrix in effect and the exact request.
- **Catalog coverage.** Community Applications templates vary widely. If an app installs wrong, or is refused for a reason that looks mistaken, open an issue with the app name and the blocker codes from a dry run.
- **Code.** Ask first for anything large, so the work is not done twice or built on a model that is about to change.

## Building and testing

You need Node.js 22 or newer and pnpm 9. From the repository root:

```sh
pnpm install --frozen-lockfile   # the committed lockfile must match
pnpm build                       # shared, then server, then the openclaw plugin
pnpm typecheck                   # tsc --noEmit across all three packages
pnpm test                        # server, archive-safety and rc TLS suites
pnpm --filter unraidclaw check-contracts   # openclaw.plugin.json tools match src registrations
```

These are the checks CI runs on every push and pull request. A change is ready when all five are green.

The server tests are offline and deterministic. The Community Applications suite runs against a trimmed catalog fixture in `packages/unraid-plugin/server/test/fixtures`, and the install, update, remove and plugin paths run against injected files and a recording command runner, so the suite never reaches the network and never runs docker or the Unraid plugin manager. Run one file during development from the server package:

```sh
pnpm --filter @unraidclaw/server exec tsx --test test/ca.test.ts
```

Two tests exercise the real public catalog. They are skipped unless you opt in, and they download about 17 MB and install nothing:

```sh
UNRAIDCLAW_LIVE_FEED=1 pnpm --filter @unraidclaw/server test
```

The archive-safety suite (`pnpm test:archive`) builds a throwaway `0.0.0.test` package and runs `packages/unraid-plugin/scripts/test_archive_safety.py` against temporary host layouts, including one where `/etc/rc.d` is a symlink. It needs `python3`. It exists because a package that carries directory headers can replace a host symlink such as `/etc/rc.d` with a plain directory on install, which hides `rc.6` and breaks shutdown. Keep the built archive free of directory headers.

The rc TLS suite (`pnpm test:tls`) runs `packages/unraid-plugin/scripts/test_rc_tls.py` with `python3`, Bash and OpenSSL. It sources the real service functions with temporary flash paths, fixture host names and addresses, and a stubbed process launch. It checks certificate SANs, one-time replacement and backups, stable address deduplication, and startup when generation fails or OpenSSL is missing. It never starts the gateway, accesses `/boot` or uses the network. `pnpm test` runs it after the archive-safety suite.

To smoke-test MCP from the bundled server without an Unraid host:

```sh
pnpm --filter "@unraidclaw/server^..." build
pnpm --filter @unraidclaw/server bundle
node packages/unraid-plugin/scripts/smoke-mcp.mjs
```

This copies the bundle outside the checkout, generates an ephemeral key in memory, starts on `127.0.0.1` with temporary flash configuration, and checks initialization, tool discovery and the read-only health tool. GraphQL points at the closed loopback port 1. The script stops the process and removes its files. It requires permission to bind a loopback socket.

The MCP and TLS Settings tests (`test/mcp-settings.test.ts` and `test/tls-settings.test.ts`) check the WebGUI page, its JavaScript and the settings PHP against the source files. The case that runs `save-settings.php` for real uses a fake service command and a temporary cfg file, and is skipped when no `php` CLI is available.

Real Unraid is the final test for anything that mutates state. The offline suite proves the gateway's logic; it cannot prove that a container actually came up or a plugin actually installed. Say in the pull request what you ran against a real server, or that you could not. Never test a destructive path against a server you do not own, and prefer `dryRun: true` first.

## Pull requests

- **Branch from `main`** and keep one topic per pull request. Split an independent part into its own request when you can.
- **Tests and docs travel with the change.**
  - A new or changed endpoint goes into the README's endpoint table, and its permission into the Permissions section.
  - A new permission key must be added in every place that mirrors it: `packages/shared/src/resources.ts` and `packages/shared/src/permissions.ts`, the WebGUI page `packages/unraid-plugin/src/usr/local/emhttp/plugins/unraidclaw/unraidclaw.page`, the WebGUI script `javascript/unraidclaw.js` (both `OCC_PRESETS` and `OCC_CATEGORIES`), and the README table. These five are kept in step by hand; a change to one without the others is a bug.
  - A new OpenClaw tool is registered in its category file under `packages/openclaw-plugin/src/tools/` and wired through `src/registry.ts`, which both the OpenClaw entry (`src/index.ts`) and the gateway's MCP adapter (`packages/unraid-plugin/server/src/mcp-tools.ts`) consume, so one registration serves both transports. It must also be declared in `openclaw.plugin.json` under `contracts.tools` and documented in the plugin's README and SKILL.md. `check-contracts` fails the build if the manifest and the registrations drift, because an undeclared tool is silently hidden from the agent. A read-only tool also belongs in the `READ_ONLY` set in `mcp-tools.ts`, or MCP clients see it as destructive.
  - A change to MCP behavior or to the TLS certificate goes into the README's MCP or TLS certificate section.
  - A user-facing behavior change gets a line under `### Unreleased` in `packages/unraid-plugin/unraidclaw.plg`.
- **Do not bump the version anywhere and do not edit the `md5` entity.** Releases rewrite the plugin version and md5 in one commit through the release workflow. A pull request that touches them will be asked to drop that change.
- **Commit messages describe the work** in plain sentences: what changed and why. No attribution trailers and no references to reviews or tools that helped write it. Match the existing style, which prefixes the area, as in `feat:`, `fix:`, `docs:`, `chore:`.
- **Allow edits from maintainers** on the pull request, so small fixes land on your branch instead of a review round trip.

## Code conventions

- The gateway talks to Unraid three ways: its GraphQL API, the `docker` and `plugin` CLIs, and the filesystem. Mutating paths run bounded commands with timeouts and verify the result afterward, for example with `docker inspect`, rather than trusting an exit code.
- Request bodies are validated by hand. The CA and plugin routes reject unknown fields and a non-boolean `dryRun` instead of letting schema coercion drop or reshape them. A new mutating route follows the same rule.
- Unsupported configurations become blockers with a code and a message, never a silent drop. If the gateway cannot reproduce a template or container setting exactly, it refuses the operation and says why.
- Secrets are redacted. Values a template marks as masked never appear in a preview, an error, or a log line.
- XML parsing goes through `packages/unraid-plugin/server/src/xml.ts`, which bounds entities and rejects unsafe constructs. Do not add a second XML parser.
- Prose in docs, comments, and messages: plain sentences, no em dashes.

## AI-assisted contributions

AI-assisted contributions are allowed. The person who opens the pull request is the author: responsible for the code, able to explain every part of it, and the one who ran it. [AGENTS.md](AGENTS.md) is the short brief an agent should read before working on the tree.

## License

UnraidClaw is MIT. By contributing you agree that your contribution is licensed the same way.
