# Working on UnraidClaw with an AI agent

AI-assisted contributions are allowed here, under one rule: **the person who opens the pull request is the author.** You are responsible for the code, you must be able to explain every line of it when asked, and you must have run it. A pull request whose author cannot answer questions about it is closed, whatever helped write it.

The rest of this page is for the agent. [CONTRIBUTING.md](CONTRIBUTING.md) holds the full guidelines; this is the short version to read before touching the tree.

## Ground rules

- **Never run a mutating operation against a real Unraid server.** No installs, updates, or removals of containers or plugins, no service restarts, no reboots. The tests inject a fake command runner and a fixture filesystem precisely so nothing has to touch a live host. When a real host is unavoidable, ask a human to run it.
- **Do not bump the version anywhere, do not tag, do not edit the `md5` entity in `packages/unraid-plugin/unraidclaw.plg`, and do not publish to npm or ClawHub.** Releases are one commit by the maintainer through the release workflow.
- **No credentials in code, tests, fixtures, logs, or commit messages.** Not even an example that looks real.
- **Commit messages say what changed and why**, in plain sentences, prefixed by area (`feat:`, `fix:`, `docs:`, `chore:`). No attribution trailers, no tool names, no references to reviews.
- **No em dashes in prose, code comments, docs, or messages.** Plain sentences, sentence case.
- Every change carries its tests and its docs. Where the docs live:
  - `README.md` for the endpoint table, the permission table, the request/response examples, and the MCP and TLS certificate sections.
  - `packages/unraid-plugin/unraidclaw.plg` under `### Unreleased` for user-facing behavior.
  - `packages/openclaw-plugin/README.md` and `SKILL.md` for the tool list and agent guidance.
  - `packages/openclaw-plugin/openclaw.plugin.json` under `contracts.tools` for every registered tool.

## Build and check

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm --filter unraidclaw check-contracts
```

These are the CI checks. `pnpm test` runs the offline server suite (Node's test runner through tsx), the archive-safety suite, which builds a throwaway package and extracts it against synthetic host layouts, including one where `/etc/rc.d` is a symlink, and the rc TLS suite. The TLS suite needs `python3`, Bash and OpenSSL and sources the real service functions with temporary flash paths, fixture host addresses and a stubbed process launch to test SANs, migration, backups and failure handling without starting the gateway, accessing `/boot` or using the network. All five must be green before you call a change done. Run one server test file during development from the server package with `pnpm --filter @unraidclaw/server exec tsx --test test/<file>.test.ts`; run the TLS suite with `pnpm test:tls`.

## Where things are

- `packages/shared`: permission keys, presets, resource categories, and API types. Both other packages import from here.
- `packages/unraid-plugin/server`: the Fastify gateway. Routes in `src/routes/`, Community Applications feed and template logic in `src/ca-*.ts`, plugin management in `src/plugins.ts`, the bounded XML parser in `src/xml.ts`. MCP transport in `src/routes/mcp.ts`, tool adapter in `src/mcp-tools.ts`, Origin and header helpers in `src/mcp-security.ts`. Tests in `test/`, fixtures in `test/fixtures/`.
- `packages/unraid-plugin/src/usr/local/emhttp/plugins/unraidclaw`: the WebGUI page and its JavaScript.
- `packages/unraid-plugin/unraidclaw.plg`: the plugin manifest, changelog, and install steps. `scripts/build.sh` builds the `.txz`; `scripts/smoke-mcp.mjs` runs the CJS bundle on loopback with temporary configuration; `scripts/test_archive_safety.py` regresses install and rollback extraction; `scripts/test_rc_tls.py` tests certificate generation and migration from `rc.d/rc.unraidclaw`.
- `packages/openclaw-plugin`: the OpenClaw tools in `src/tools/`, their transport-neutral registration in `src/registry.ts` and OpenClaw entry in `src/index.ts`, and the contract check in `scripts/check-contracts.mjs`.

## Rules the code already follows

- Permissions are defined once in `packages/shared` and mirrored by hand in the WebGUI page, the WebGUI JavaScript, and the README table. A permission change updates all of them or it is wrong.
- New permissions default to off. A preset grants only what its description promises.
- Request bodies are validated by hand. Unknown fields are rejected and `dryRun` must be a real boolean, so a mistyped dry run cannot become a real operation. Mutating OpenClaw tools declare `additionalProperties: false` and re-check their parameters before making any HTTP request.
- An unsupported template or container setting becomes a blocker with a code, never a silent drop. If the gateway cannot reproduce a setting exactly, it refuses and says why.
- A mutation is verified against real state afterward, such as `docker inspect` or the plugin registration, not the exit code of a helper.
- Masked secrets stay redacted in previews, errors, and logs.
- The release package carries no directory headers, and the manifest installs it with `TAR_OPTIONS="--keep-directory-symlink --no-overwrite-dir"`. tar replaces a host directory symlink such as `/etc/rc.d` with a plain directory when an archive carries that directory's header, which once left a server unable to shut down. Keep `build.sh` and the manifest this way and keep the archive-safety suite green.
- XML parsing goes through `src/xml.ts`. Do not hand-roll a parser or reach for a regex.
- The tool definitions live once, in `packages/openclaw-plugin/src/tools/`, and reach OpenClaw and MCP through the same registry (`unraidclaw/tools`). The MCP adapter in `src/mcp-tools.ts` runs each call through the gateway's own `/api/` route with `app.inject`; it is never a network client, and a read-only tool must be listed in its `READ_ONLY` set to get `readOnlyHint`.
- MCP is off by default and stays off unless `MCP_ENABLED="yes"` is in the cfg. The Origin allowlist is built at startup from loopback, the local interfaces and the configured Listen Host; never derive it from request headers.

## The real host

The gateway runs on people's Unraid servers, across versions, plugins, and Docker setups. When you cannot test a change against a real server, say so in the pull request instead of describing a test you did not run.
