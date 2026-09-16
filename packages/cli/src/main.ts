import { dirname, join } from "node:path";
import { isErrorResult, type ToolClient } from "unraidclaw/tools";
import { version } from "../package.json";
import { commands, parse, argumentsFor, help, type Parsed } from "./commands.js";
import { Configuration, environment, gatewayUrl, type Environment, type Settings } from "./config.js";
import { CliError, Secrets, usage } from "./errors.js";
import { format } from "./output.js";
import { terminal, type Terminal } from "./terminal.js";
import { HttpClient, peerCertificate } from "./transport.js";

export interface Runtime {
  context?: Environment;
  terminal?: Terminal;
  client?: (settings: Settings) => ToolClient & { failure?: CliError };
}

export async function run(argv: string[], runtime: Runtime = {}): Promise<number> {
  const context = runtime.context ?? environment();
  const io = runtime.terminal ?? terminal();
  const secrets = new Secrets();
  secrets.add(context.env.UNRAIDCLAW_KEY);
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--key") secrets.add(argv[index + 1]);
    if (argv[index].startsWith("--key=")) secrets.add(argv[index].slice(6));
  }
  const out = (text: string) => io.out(secrets.redact(text) + (text.endsWith("\n") ? "" : "\n"));
  const err = (text: string) => io.err(secrets.redact(text) + "\n");
  try {
    const catalog = commands(new HttpClient({}));
    const parsed = parse(argv, catalog);
    const globals = parsed.globals;
    if (globals.key !== undefined) err("Warning: --key is visible in the process list. Prefer UNRAIDCLAW_KEY or config set-key.");
    if (globals.version) {
      if (parsed.words.length) usage("--version takes no command.");
      out(`unraidclaw ${process.env.UNRAIDCLAW_BUILD_VERSION || version}`); return 0;
    }
    if (globals.help || !parsed.words.length || parsed.words[0] === "help") {
      out(help(catalog, parsed.words[0] === "help" ? parsed.words.slice(1) : parsed.command && parsed.words.length > 1 ? parsed.command.name.split(" ") : parsed.words));
      return 0;
    }
    if (parsed.words[0] === "tools") {
      if (parsed.words.length !== 1) usage("tools takes no positional arguments.");
      out(format(catalog.map(command => ({ command: command.name, tool: command.tool.name, readOnly: command.readOnly })), output(parsed)));
      return 0;
    }
    const settings: Settings & { config?: string } = {
      url: globals.url as string | undefined,
      key: globals.key as string | undefined,
      caCert: globals["ca-cert"] as string | undefined,
      insecure: globals.insecure as boolean | undefined,
      config: globals.config as string | undefined,
    };
    if (!parsed.command && !["config", "trust"].includes(parsed.words[0])) usage("Unknown command. See unraidclaw help.");
    // Argument validation happens before config reads, confirmation or transport.
    const args = parsed.command ? await argumentsFor(parsed) : undefined;
    const config = await Configuration.load(settings, context, secrets);
    if (parsed.words[0] === "config") {
      await configure(parsed, config, io, secrets, out); return 0;
    }
    if (parsed.words[0] === "trust") {
      if (parsed.words.length !== 1 || globals["args-json"] !== undefined) usage("trust takes only global flags.");
      const url = gatewayUrl(config.settings.url);
      err("Warning: retrieving an unverified certificate. Compare its SHA-256 fingerprint with the one shown in the UnraidClaw WebGUI.");
      const cert = await peerCertificate(url);
      const details = { subject: cert.subject, subjectAltName: cert.subjectAltName ?? "", expiry: cert.validTo, fingerprint: cert.fingerprint256 };
      // Keep stdout machine-readable when --output json is used.
      err(format(details));
      await confirm("Trust this certificate?", !!globals.yes, io, err);
      const host = url.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
      const path = join(dirname(config.path), `${host}-${url.port || "443"}.pem`);
      await config.writePrivate(path, cert.toString());
      await config.save({ url: url.origin, caCert: path, insecure: false });
      const saved = { url: url.origin, caCert: path, insecure: false };
      out(format(output(parsed) === "json" ? { ...details, caCert: path, url: url.origin, insecure: false } : saved, output(parsed)));
      return 0;
    }
    const command = parsed.command!;
    gatewayUrl(config.settings.url);
    if (config.settings.insecure) err("Warning: TLS certificate verification is disabled.");
    const dryRun = Object.hasOwn(command.schema.properties, "dryRun") && args!.dryRun === true;
    if (!command.readOnly && !dryRun) {
      // Values may contain masked template data. Describe the tool and argument
      // names only, with no secret-bearing previews on stdout or stderr.
      const fields = Object.keys(args!).filter(key => Object.hasOwn(command.schema.properties, key)).join(", ") || "none";
      await confirm(`Would run ${command.name} on ${gatewayUrl(config.settings.url).origin}. Argument fields: ${fields}.`, !!globals.yes, io, err);
    }
    const client = runtime.client?.(config.settings) ?? new HttpClient(config.settings);
    const executable = commands(client).find(entry => entry.name === command.name)!;
    const result = await executable.tool.execute("cli", args!);
    if (isErrorResult(result)) throw client.failure ?? new CliError("Tool execution failed. Check the command arguments.");
    let data: unknown;
    try { data = JSON.parse(result.content[0].text); }
    catch { throw new CliError("Tool returned invalid JSON data."); }
    out(format(data, output(parsed)));
    return 0;
  } catch (error) {
    err(error instanceof CliError ? error.message : "Command failed. Check configuration and input.");
    return error instanceof CliError ? error.exitCode : 1;
  }
}

function output(parsed: Parsed): "table" | "json" { return parsed.globals.output === "json" ? "json" : "table"; }

async function confirm(description: string, yes: boolean, io: Terminal, err: (text: string) => void): Promise<void> {
  if (yes) return;
  err(description);
  if (!io.interactive) usage("Confirmation required. Pass --yes to proceed when stdin or stdout is not a TTY.");
  if (!await io.confirm("Proceed?")) throw new CliError("Cancelled. Nothing was changed.");
}

async function configure(parsed: Parsed, config: Configuration, io: Terminal, secrets: Secrets, out: (text: string) => void): Promise<void> {
  const [, action, name, value, ...extra] = parsed.words;
  if (extra.length || parsed.globals["args-json"] !== undefined) usage("Invalid config command. See config --help.");
  if (action === "path" && name === undefined) { out(format(config.path, output(parsed))); return; }
  if (action === "show" && name === undefined) { out(format(config.masked(), output(parsed))); return; }
  if (action === "set-key" && name === undefined) {
    const key = await io.readKey();
    secrets.add(key);
    if (!key || /[\r\n\0]/.test(key)) usage("The API key must be one nonempty line.");
    await config.save({ key });
  } else if (action === "set" && value !== undefined) {
    if (name === "url") await config.save({ url: gatewayUrl(value).origin });
    else if (name === "ca-cert") await config.save({ caCert: value });
    else if (name === "insecure" && ["true", "false"].includes(value)) await config.save({ insecure: value === "true" });
    else usage("Use config set url, ca-cert, or insecure true|false. Use config set-key for the API key.");
  } else usage("Invalid config command. See config --help.");
  out(format({ saved: true, path: config.path }, output(parsed)));
}
