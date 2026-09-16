# UnraidClaw command-line client

`unraidclaw` manages one UnraidClaw gateway through its REST API. It uses the same 55 tool definitions and read-only classification as OpenClaw and MCP. Node.js 22 or newer is required on Linux, macOS and Windows. The CLI is a single CommonJS bundle with no runtime `node_modules` requirement.

## Install

The Unraid plugin installs `/usr/local/bin/unraidclaw` automatically.

For another machine, download `unraidclaw-cli-<version>.tar.gz` and its `.sha256` file from the [latest release](https://github.com/emaspa/unraidclaw/releases/latest). The archive holds the bundle `unraidclaw.cjs`, a `unraidclaw` launcher for Linux and macOS, `unraidclaw.cmd` for Windows, this guide and the license. Node.js 22 or newer must be on `PATH`.

```sh
sha256sum -c unraidclaw-cli-<version>.tar.gz.sha256   # macOS: shasum -a 256 -c
tar -xzf unraidclaw-cli-<version>.tar.gz
sudo ln -s "$PWD/unraidclaw-cli-<version>/unraidclaw" /usr/local/bin/unraidclaw
unraidclaw --version
```

On Windows, extract the archive with `tar -xzf` in a terminal and add the extracted folder to `PATH`, or run `unraidclaw.cmd` from it.

To build from source instead, run these commands from the repository root:

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm build
npm install -g ./packages/cli
unraidclaw --version
```

You can also copy `packages/cli/dist/unraidclaw.cjs` to another machine and run `node unraidclaw.cjs help`. The package is not published to npm. The CLI package is named `unraidclaw-cli`; the OpenClaw plugin is the separate `unraidclaw` npm package.

## Configure a remote machine

```sh
unraidclaw config set url "https://<server>:9876"
unraidclaw trust
unraidclaw config set-key
unraidclaw docker list
```

`trust` retrieves the public certificate without verification or an API key. It prints the subject, alternative names, expiry and SHA-256 fingerprint. Compare the fingerprint with **Settings > UnraidClaw > Settings > TLS Certificate** in the WebGUI before confirming. In table mode the details go to stderr before confirmation; stdout reports only the saved `url`, `caCert` and `insecure` settings. With `--output json`, stdout also keeps the certificate details. It saves the displayed PEM as `<config dir>/<host>-<port>.pem`, sets `caCert` and `url`, and sets `insecure` to false in the config. IPv6 punctuation is replaced with underscores in the filename. The server certificate must include the address you use in its alternative names. After regeneration, verify and trust the new certificate again.

`config set-key` reads the key from a hidden terminal prompt, or from stdin when piped. It never takes the key as a positional argument. Prefer a password manager that writes directly to stdin over a shell command containing a literal key. The gateway stores only a hash and cannot recover the key for you.

If you already have a trusted certificate copy, use `config set ca-cert <path>` or `--ca-cert <path>`. A public CA certificate works through the normal Node trust store without these flags.

## Configuration

Precedence is command-line flags, environment variables, config file, then local Unraid defaults. Each setting is resolved independently. `config show` shows effective settings with the key masked; `config path` reports the selected file. `--config <path>` selects another file, including a new file for config commands.

| Setting | Flag | Environment | JSON field |
|---------|------|-------------|------------|
| Gateway origin | `--url` | `UNRAIDCLAW_URL` | `url` |
| API key | `--key` | `UNRAIDCLAW_KEY` | `key` |
| Trusted certificate | `--ca-cert` | `UNRAIDCLAW_CA_CERT` | `caCert` |
| Skip TLS verification | `--insecure`, `--no-insecure` | `UNRAIDCLAW_INSECURE` | `insecure` |

`UNRAIDCLAW_TLS_SKIP` is an alias used only when `UNRAIDCLAW_INSECURE` is absent. Environment booleans accept `true/false`, `yes/no` and `1/0`. `--tls-skip` also aliases `--insecure`. Executing a tool with verification disabled prints a warning. `--key` prints a warning because argv is visible in the process list. Environment variables still override saved settings after `trust`.

The JSON file accepts only `url`, `key`, `caCert` and `insecure`. For example, settings without a saved key:

```json
{
  "url": "https://<server>:9876",
  "insecure": false
}
```

Default locations:

| Platform | Config path |
|----------|-------------|
| Linux/macOS | `$XDG_CONFIG_HOME/unraidclaw/config.json`, otherwise `~/.config/unraidclaw/config.json` |
| Windows | `%APPDATA%\unraidclaw\config.json`, otherwise `~\AppData\Roaming\unraidclaw\config.json` |
| Unraid server | `/boot/config/plugins/unraidclaw/cli.json` |

Files are written atomically with mode `0600`, in a directory created with mode `0700`. On POSIX, reading a file accessible by group or others is refused. Fix that with `chmod 600 <config path>`. An existing directory must also be private before writing, use `chmod 700 <config dir>`. Choose a dedicated config directory rather than changing a shared directory's permissions. The mode checks are skipped on Windows and on the Unraid flash, which uses FAT. Config symlinks are refused on POSIX. Relative config and certificate paths are relative to the working directory.

Other configuration commands:

```sh
unraidclaw config set ca-cert /path/to/cert.pem
unraidclaw config set insecure false
unraidclaw config show --output json
unraidclaw config path
```

## Use on the Unraid server

The CLI detects `/boot/config/plugins/unraidclaw/unraidclaw.cfg`. Without a configured URL, it reads `PORT` from simple `KEY="value"` lines, defaulting to `9876`. It never executes the cfg. If `tls/cert.pem` exists, the default is `https://127.0.0.1:<port>` and that certificate is trusted locally. Otherwise the default is `http://127.0.0.1:<port>`. The automatic local CA is only applied when the URL is discovered and no CA is already configured. An explicit URL, even a local one, disables this discovery. Discovery does not read `HOST`, `TLS_CERT` or `TLS_KEY`; use explicit URL and certificate settings for those configurations.

Run `unraidclaw config set-key` once, then commands such as `unraidclaw array status`. `/root` does not survive reboots, so config is saved on flash. **This stores the CLI key in plain text on the flash drive**, alongside the Unraid API key already held in `unraidclaw.cfg`. Protect flash backups. Use an environment variable instead if you do not want to persist the key.

The plugin wrapper tries `/usr/local/bin/node`, then `/usr/bin/node`, then `node` on PATH. Its bundle lives at `/usr/local/emhttp/plugins/unraidclaw/cli/unraidclaw.cjs`.

## Commands and arguments

Commands are generated from the shared registry: remove `unraid_`, use the first segment as the group, and join remaining segments with hyphens for the action. For example, `unraid_vm_force_stop` becomes `vm force-stop`. `unraid_syslog` remains the single command `syslog`.

`unraidclaw help`, `unraidclaw` and `unraidclaw --help` show a compact group overview, built-in commands and global flags. `unraidclaw docker --help` or `unraidclaw help docker` lists the group's commands with read-only or mutating status, the first sentence of each description and aliases. `unraidclaw docker create --help` shows the full description and every schema flag for that command. `unraidclaw tools --output json` lists every canonical command, tool name and read-only status. These views are generated directly from the registry.

The complete current command list, with each action combined with its group:

| Group | Actions |
|-------|---------|
| `array` | `start`, `status`, `stop` |
| `ca` | `app`, `install`, `remove`, `search`, `update` |
| `disk` | `details`, `list` |
| `docker` | `create`, `inspect`, `list`, `logs`, `pause`, `remove`, `restart`, `start`, `stop`, `unpause` |
| `health` | `check` |
| `network` | `info` |
| `notification` | `archive`, `create`, `delete`, `list` |
| `parity` | `cancel`, `pause`, `resume`, `start`, `status` |
| `plugin` | `check-updates`, `info`, `install`, `remove`, `update` |
| `plugins` | `list` |
| `service` | `list` |
| `share` | `details`, `list`, `update` |
| `system` | `info`, `metrics`, `reboot`, `shutdown` |
| `user` | `me` |
| `vm` | `force-stop`, `inspect`, `list`, `pause`, `reboot`, `resume`, `start`, `stop` |
| Single command | `syslog` |

Aliases: `health` means `health check`, `plugin list` means `plugins list`, and `log syslog` means `syslog`. Every canonical spelling stays available. Built-in commands are `help`, `tools`, `trust`, `config set`, `config set-key`, `config show`, `config path`, and `--version`.

Required string targets named `id`, `name` or `plugin` can be positional. Every schema property also has a kebab-case flag, including `--id` and `--name`. Other required fields, such as `--image` or `--q`, use flags. The OpenClaw `server` parameter is not exposed.

```sh
unraidclaw docker inspect jellyfin
unraidclaw docker logs --id jellyfin --tail 50
unraidclaw ca search --q jellyfin --limit 5
unraidclaw docker create --image nginx:latest --ports 8080:80 --ports 8443:443 --yes
unraidclaw ca install Jellyfin --overrides '{"PUID":"99"}' --dry-run
unraidclaw docker remove jellyfin --no-force --yes
unraidclaw vm start my-vm --yes
```

Global flags (also shown by `--help`):

| Flag | Purpose |
|------|---------|
| `--url <origin>`, `--key <key>`, `--ca-cert <path>` | Override connection settings |
| `--insecure`, `--no-insecure`, `--tls-skip` | Enable or disable TLS verification skipping |
| `--config <path>` | Select the config file |
| `--output table\|json` | Select output format |
| `--yes` | Skip interactive confirmation, including for `trust` |
| `--args-json <json\|@file>` | Supply tool arguments |
| `--help`, `-h` | Show help |
| `--version` | Show the CLI package version |

Booleans use `--force` or `--no-force`, never `--force=false`. Numbers and enums are validated against the tool's schema. Repeat a primitive array flag for each element. Objects and complex arrays take a JSON value. `--args-json '<json>'` or `--args-json @file.json` supplies the argument object; explicit flags and positional targets override fields from that object. Unknown fields and flags, invalid JSON and schema errors are rejected before any request. A scalar flag cannot be repeated.

Global flags can appear before or after the command. There is one collision: `plugin install` has its own `url` property. Put the gateway `--url` before the command and the plugin source `--url` after it:

```sh
unraidclaw --url "https://<server>:9876" plugin install --url https://example.invalid/plugin.plg --dry-run
```

## Safety and output

A command absent from the shared `READ_ONLY` set requires confirmation. If both stdin and stdout are TTYs, the CLI asks before executing. Otherwise it describes the command and argument field names on stderr and refuses without `--yes`. Argument values are omitted from confirmation text because templates can contain secrets. A command whose schema supports `dryRun` skips confirmation when its effective argument is exactly `true`, whether supplied by `--dry-run` or `--args-json`. Explicit flags override JSON arguments: `--no-dry-run` restores confirmation even if the JSON sets `dryRun` to true. False or omitted values still require confirmation, and non-boolean values are rejected. The CLI never invents a dry-run mode for tools that lack one. Declining exits without a request. Read-only commands never prompt. Gateway permissions remain the final authority.

Default output, also selected by `--output table`, uses aligned tables for object lists and key/value lines for objects. Tables show up to eight columns, put `name` and `names` before `id`, and render scalar arrays as comma-separated values. Cells longer than 40 characters end with `...`; values in an `id` column longer than 24 characters show the first 12 characters after the last `:`, because gateway ids can start with a server prefix shared by every row. Multiline strings and string-array entries start on separate unindented lines below their key, so logs remain readable without truncation. Nested objects use two spaces of indentation per level, and arrays of objects remain sub-tables. `--output json` preserves the tool's JSON data without the REST envelope or a CLI wrapper. Known API key values are redacted in every output format. Config commands always mask the key. The CLI emits no color. Prompts and errors go to stderr.

| Exit code | Meaning |
|-----------|---------|
| `0` | Success |
| `1` | API, connection or other error, or interactive cancellation |
| `2` | Usage, validation, configuration input or missing confirmation |
| `3` | HTTP 401 authentication failure |
| `4` | HTTP 403 permission denial |

API errors retain the gateway code and message, for example `FORBIDDEN: Permission denied: docker:delete`. Requests time out after 30 seconds, responses are limited to 32 MiB, and redirects are never followed. HTTP is supported for a gateway without TLS, but it transmits the API key unencrypted. Prefer verified HTTPS. `--insecure` disables peer verification and should not be a substitute for verifying the certificate fingerprint.

## Connection errors

Connection failures exit with code 1 and identify the likely cause without printing the API key. `trust` uses the same diagnostics for connection and TLS protocol failures.

| Diagnostic | What to check |
|------------|---------------|
| Certificate is not trusted | Run `unraidclaw trust`, use `--ca-cert <path>`, or check that configured `caCert` matches the server. A regenerated certificate needs trusting again. |
| URL host or IP is not listed in the certificate | Use an address from its alternative names, or regenerate the certificate in Settings > UnraidClaw > Settings and trust it again. Trusting alone cannot fix an address mismatch. |
| Certificate has expired or is not yet valid | Check the clocks and, for an expired certificate, regenerate and trust it again. |
| Nothing is listening at the gateway origin | Check the port and that the UnraidClaw service is running. |
| Cannot resolve the host | Check the host name and DNS settings. |
| Host unreachable or connection timed out | Check connectivity and firewall settings. The request and certificate retrieval deadlines are 30 seconds. |
| Connection reset or TLS protocol mismatch | Check `http` vs `https` and that the port uses the selected protocol. |
| Other connection failure | The diagnostic includes the Node error code when available. |

## Development checks

From the repository root, run `pnpm build`, `pnpm typecheck`, `pnpm test` and `pnpm --filter unraidclaw check-contracts`. CLI tests use Node's test runner through tsx, temporary filesystem roots and generated keys. The HTTPS test uses the real gateway, an OpenSSL-generated certificate and loopback only. It skips explicitly if OpenSSL is missing or the sandbox refuses loopback binding. No test contacts a real Unraid server.
