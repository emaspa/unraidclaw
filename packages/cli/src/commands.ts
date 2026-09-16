import { parseArgs, type ParseArgsConfig } from "node:util";
import { readFile } from "node:fs/promises";
import Ajv, { type ValidateFunction } from "ajv";
import { registerTools, READ_ONLY, type ToolClient, type ToolDefinition } from "unraidclaw/tools";
import { usage } from "./errors.js";

export interface Schema {
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: Schema;
  [key: string]: unknown;
}
export interface Command {
  name: string;
  tool: ToolDefinition;
  schema: ToolDefinition["parameters"] & { properties: Record<string, Schema> };
  readOnly: boolean;
  validate: ValidateFunction;
}
export const aliases: Record<string, string> = {
  health: "health check",
  "plugin list": "plugins list",
  "log syslog": "syslog",
};
export const kebab = (value: string): string => value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replaceAll("_", "-").toLowerCase();
export const commandName = (name: string): string => {
  const [group, ...action] = name.replace(/^unraid_/, "").split("_");
  return [group, action.join("-")].filter(Boolean).join(" ");
};

export function commands(client: ToolClient): Command[] {
  const result: Command[] = [];
  const ajv = new Ajv({ coerceTypes: false, useDefaults: false, removeAdditional: false });
  registerTools({ registerTool(tool) {
    const { server: _server, ...properties } = tool.parameters.properties ?? {};
    const schema = {
      ...tool.parameters,
      properties: properties as Record<string, Schema>,
      required: (tool.parameters.required ?? []).filter(key => key !== "server"),
      additionalProperties: false,
    };
    result.push({ name: commandName(tool.name), tool, schema, readOnly: READ_ONLY.has(tool.name), validate: ajv.compile(schema) });
  } }, () => client);
  if (new Set(result.map(command => command.name)).size !== result.length) throw new Error("Duplicate CLI command registration");
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

const globals = {
  url: { type: "string" }, key: { type: "string" }, "ca-cert": { type: "string" },
  insecure: { type: "boolean" }, "no-insecure": { type: "boolean" }, "tls-skip": { type: "boolean" },
  config: { type: "string" }, output: { type: "string" }, yes: { type: "boolean" },
  help: { type: "boolean", short: "h" }, version: { type: "boolean" }, "args-json": { type: "string" },
} satisfies ParseArgsConfig["options"];
type Options = NonNullable<ParseArgsConfig["options"]>;
export interface Parsed {
  globals: Record<string, string | boolean>;
  command?: Command;
  words: string[];
  values: Record<string, unknown>;
}

function optionSchema(schema: Schema): Options[string] {
  return { type: schema.type === "boolean" ? "boolean" : "string", multiple: schema.type === "array" };
}

/** Discovery only identifies command words. The second pass rejects unrelated flags. */
export function parse(argv: string[], catalog: Command[]): Parsed {
  const all: Options = { ...globals };
  for (const command of catalog) for (const [name, schema] of Object.entries(command.schema.properties)) {
    const flag = kebab(name);
    all[flag] ??= optionSchema(schema);
    if (schema.type === "boolean") all[`no-${flag}`] = { type: "boolean" };
  }
  let discovery;
  try { discovery = parseArgs({ args: argv, options: all, allowPositionals: true, tokens: true }); }
  catch { return usage("Unknown flag or missing/invalid flag value. See unraidclaw help."); }
  const words = discovery.positionals;
  const firstTwo = words.slice(0, 2).join(" ");
  const resolved = aliases[firstTwo] ?? firstTwo;
  let command = catalog.find(command => command.name === resolved);
  let count = 2;
  if (!command) {
    command = catalog.find(command => command.name === (aliases[words[0]] ?? words[0]));
    count = 1;
  }
  const options: Options = { ...globals };
  if (command) for (const [name, schema] of Object.entries(command.schema.properties)) {
    const flag = kebab(name);
    options[flag] = optionSchema(schema);
    if (schema.type === "boolean") options[`no-${flag}`] = { type: "boolean" };
  }
  let parsed;
  try { parsed = parseArgs({ args: argv, options, allowPositionals: true, tokens: true }); }
  catch { return usage("Unknown flag or missing/invalid flag value for this command. See its --help."); }
  const result: Parsed = { globals: {}, command, words, values: Object.create(null) };
  const positionals = parsed.tokens.filter(token => token.kind === "positional");
  const commandEnd = positionals[count - 1]?.index ?? -1;
  const flagNames = new Map(Object.keys(command?.schema.properties ?? {}).map(name => [kebab(name), name]));
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    const negative = token.name.startsWith("no-");
    const flag = negative ? token.name.slice(3) : token.name;
    const property = flagNames.get(flag);
    if (command && property && (!(token.name in globals) || token.index > commandEnd)) {
      const schema = command.schema.properties[property];
      const value = schema.type === "boolean" ? !negative : typedValue(token.value!, schema);
      if (schema.type === "array" && primitiveArray(schema)) {
        const previous = result.values[property] as unknown[] | undefined;
        result.values[property] = [...(previous ?? []), value];
      } else {
        if (Object.hasOwn(result.values, property)) usage("A scalar or JSON flag may only be supplied once.");
        result.values[property] = value;
      }
    } else {
      const name = token.name === "tls-skip" || token.name === "no-insecure" ? "insecure" : token.name;
      if (Object.hasOwn(result.globals, name)) usage("A global flag may only be supplied once.");
      result.globals[name] = token.value ?? !negative;
    }
  }
  if (command) {
    const targets = (command.schema.required ?? []).filter(name => ["id", "name", "plugin"].includes(name) && command.schema.properties[name].type === "string");
    const values = words.slice(count);
    if (values.length > targets.length) usage("Too many positional arguments. Use the named flags shown in --help.");
    values.forEach((value, index) => {
      const name = targets[index];
      if (Object.hasOwn(result.values, name)) usage("Supply a target positionally or by flag, only once.");
      result.values[name] = value;
    });
  }
  if (result.globals.output !== undefined && !["table", "json"].includes(String(result.globals.output))) usage("--output must be table or json.");
  return result;
}

function primitiveArray(schema: Schema): boolean {
  return schema.type === "array" && ["string", "number", "integer", "boolean"].includes(schema.items?.type ?? "");
}
function jsonValue(value: string): unknown {
  try { return JSON.parse(value); } catch { return usage("Invalid JSON argument. Values were not sent to the gateway."); }
}
function typedValue(value: string, schema: Schema): unknown {
  if (primitiveArray(schema)) return typedValue(value, schema.items!);
  if (schema.type === "string") return value;
  if (schema.type === "number" || schema.type === "integer") {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) usage("Expected a finite number.");
    return Number(value);
  }
  return jsonValue(value);
}

export async function argumentsFor(parsed: Parsed): Promise<Record<string, unknown>> {
  let base: unknown = {};
  const input = parsed.globals["args-json"];
  if (typeof input === "string") {
    let text = input;
    if (input.startsWith("@")) {
      try { text = await readFile(input.slice(1), "utf8"); }
      catch { usage("Cannot read --args-json file."); }
    }
    base = jsonValue(text);
    if (!base || typeof base !== "object" || Array.isArray(base)) usage("--args-json must contain an object.");
  }
  const values = { ...base as Record<string, unknown>, ...parsed.values };
  if (!parsed.command!.validate(values)) {
    // Schema paths and values can contain secrets. Report only known properties.
    const required = parsed.command!.schema.required ?? [];
    usage(`Invalid arguments. Check types, enums and unknown fields in --help. Required fields: ${required.join(", ") || "none"}. Nothing was sent to the gateway.`);
  }
  return values;
}

const shortGlobalHelp = `Global flags: --url <origin>, --key <key>, --ca-cert <path>, --insecure,
  --no-insecure, --tls-skip, --config <path>, --output table|json, --yes,
  --args-json <json|@file>, --help (-h), --version.`;

export const globalHelp = `${shortGlobalHelp}
Use UNRAIDCLAW_KEY or config set-key to keep credentials out of argv.
For plugin install, put the gateway --url before the command and the plugin --url after it.
Mutations require confirmation or --yes, except supported dry runs with dryRun exactly true.`;

const groupSummaries: Record<string, string> = {
  array: "Array state and control", ca: "Community Applications", disk: "Array disks",
  docker: "Docker containers", health: "Gateway health", network: "Network interfaces",
  notification: "Notifications", parity: "Parity checks", plugin: "Plugin management",
  plugins: "Installed plugins", service: "Unraid services", share: "User shares",
  system: "System information and power", user: "Current user", vm: "Virtual machines",
};
const usageLine = "Usage: unraidclaw [global flags] <group> <action> [arguments]";

export function help(catalog: Command[], words: string[] = []): string {
  if (!words.length) {
    const groups = [...new Set(catalog.filter(command => command.name.includes(" ")).map(command => command.name.split(" ")[0]))];
    const rows = groups.map(group => {
      const actions = catalog.filter(command => command.name.startsWith(group + " ")).map(command => command.name.split(" ")[1]);
      return `  ${group.padEnd(14)}${groupSummaries[group] ?? group}: ${actions.slice(0, 4).join(", ")}${actions.length > 4 ? ", ..." : ""}`;
    });
    const singles = catalog.filter(command => !command.name.includes(" ")).map(command =>
      `  ${command.name.padEnd(14)}${firstSentence(command.tool.description)}`);
    return `${usageLine}\n\nGroups:\n${rows.join("\n")}\n\nOther commands:
${singles.join("\n")}
  tools         List all commands and their read-only status
  config        Set or show gateway configuration
  trust         Inspect and trust the gateway certificate
  help          Show help

Use unraidclaw <group> --help to list its commands.
Use unraidclaw <group> <action> --help for descriptions and flags.

${shortGlobalHelp}`;
  }
  if (words[0] === "config") return `Config commands:
  config set url <url>
  config set ca-cert <path>
  config set insecure true|false
  config set-key    Read from stdin or a hidden terminal prompt
  config show       Show effective settings with the key masked
  config path       Show the configuration file path\n\n${globalHelp}`;
  if (words[0] === "trust") return `trust [--url <origin>] [--yes]
Inspect the certificate without verification, compare its SHA-256 fingerprint
with Settings > UnraidClaw in the WebGUI, and confirm before saving it.\n\n${globalHelp}`;
  const target = words.join(" ");
  const isGroup = words.length === 1 && (catalog.some(command => command.name.startsWith(target + " ")) ||
    Object.keys(aliases).some(alias => alias.startsWith(target + " ")));
  const selected = isGroup ? target : aliases[target] ?? target;
  const subset = catalog.filter(command => !selected || command.name === selected || command.name.startsWith(selected + " ") ||
    Object.entries(aliases).some(([alias, name]) => alias.startsWith(selected + " ") && name === command.name));
  if (!subset.length) usage("Unknown command or group. See unraidclaw help.");
  const rows = subset.map(command => {
    const targets = (command.schema.required ?? []).filter(name => ["id", "name", "plugin"].includes(name));
    const alias = Object.entries(aliases).filter(([, name]) => name === command.name).map(([name]) => name);
    const properties = isGroup ? [] : Object.entries(command.schema.properties).map(([name, schema]) => {
      const type = schema.enum ? schema.enum.map(String).join("|") : schema.type;
      return `    --${kebab(name)} ${schema.type === "boolean" ? `(also --no-${kebab(name)})` : `<${type}>`}${command.schema.required?.includes(name) ? " (required)" : ""}: ${schema.description ?? ""}`;
    });
    return [`  ${command.name}${targets.map(name => ` [${name}]`).join("")} (${command.readOnly ? "read-only" : "mutating"})${alias.length ? `, aliases: ${alias.join(", ")}` : ""}`,
      `    ${isGroup ? firstSentence(command.tool.description) : command.tool.description}`, ...properties].join("\n");
  });
  return `${usageLine}\n\n${rows.join("\n\n")}\n\n${isGroup
    ? "Use unraidclaw <group> <action> --help for the full description and flags."
    : globalHelp}`;
}

function firstSentence(description: string): string {
  return description.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? description;
}
