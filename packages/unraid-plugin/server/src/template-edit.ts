// Editing the saved docker-manager template of an installed container.
//
// The update path in ca-saved-template.ts rebuilds a container from its
// template with its own argv, and so refuses every setting it cannot reproduce
// exactly: Extra Parameters, privileged mode, devices, custom networks, fixed
// IPs, CPU pinning, Tailscale. A template edit takes the other route. It changes
// the template the way the Docker tab's edit form does, and then has Unraid's
// own xmlToCommand build the docker command from it (see
// scripts/docker-command), so whatever the Docker tab supports on this server,
// an edit supports too, with the same result.
//
// This module is the part that needs no host: reading an edit request, applying
// it to the template XML, and describing what changed. It never runs anything.

import { XMLBuilder } from "fast-xml-parser";
import type {
  CaConfigType,
  TemplateChange,
  TemplateConfigEdit,
  TemplateConfigRef,
  TemplateConfigView,
  TemplateEditRequest,
  TemplateSettingKey,
  TemplateView,
} from "@unraidclaw/shared";
import { CaInstallError, isSecretEntry } from "./ca-template.js";
import { splitArgs, validDevice, MAX_ARGS_LENGTH } from "./docker-common.js";
import { ATTR_PREFIX, XmlParseError, asArray, attrOf, parseXmlDocument, textOf } from "./xml.js";

/** Elements an edit may set. Kept in the order Unraid's postToXML writes them. */
export const SETTING_KEYS: readonly TemplateSettingKey[] = [
  "Repository", "Registry", "Network", "ExtraNetworks", "MyIP", "MyMAC", "Shell", "Privileged",
  "WebUI", "Icon", "ExtraParams", "PostArgs", "CPUset", "Memory",
  "TailscaleEnabled", "TailscaleIsExitNode", "TailscaleHostname", "TailscaleExitNodeIP",
  "TailscaleSSH", "TailscaleUserspaceNetworking", "TailscaleLANAccess", "TailscaleServe",
  "TailscaleWebUI", "TailscaleServePort", "TailscaleServeTarget", "TailscaleServeLocalPath",
  "TailscaleServeProtocol", "TailscaleServeProtocolPort", "TailscaleServePath",
  "TailscaleDParams", "TailscaleParams", "TailscaleRoutes", "TailscaleAcceptRoutes",
  "TailscaleTroubleshooting", "TailscaleStateDir",
];
const SETTING_SET = new Set<string>(SETTING_KEYS);

/** Settings Unraid reads as the literal text "true" or anything else. */
const BOOLEAN_SETTINGS = new Set<string>(["Privileged", "TailscaleEnabled"]);

const CONFIG_TYPES = new Set<CaConfigType>(["Port", "Path", "Variable", "Label", "Device"]);

/** The Mode values xmlToVar keeps. Anything else it silently rewrites to rw or tcp. */
const PATH_MODES = new Set(["rw", "rw,slave", "rw,shared", "ro", "ro,slave", "ro,shared"]);
const PORT_MODES = new Set(["tcp", "udp"]);
const DISPLAY_VALUES = new Set(["always", "always-hide", "advanced", "advanced-hide"]);

const EDIT_FIELDS = ["type", "target", "value", "name", "mode", "default", "description", "display", "required", "mask", "replaces"];
const REF_FIELDS = ["type", "target", "mode", "value"];
const BODY_FIELDS = ["settings", "config", "removeConfig", "pull", "dryRun"];

/** Attributes of a new `<Config>`, in the order the Docker tab writes them. */
const CONFIG_ATTRS = ["Name", "Target", "Default", "Mode", "Description", "Type", "Display", "Required", "Mask"];

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new CaInstallError(message, "TEMPLATE_INVALID_BODY", 400, details);
}

function checkFields(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key)) continue;
    const near = allowed.find((a) => a.toLowerCase() === key.toLowerCase());
    invalid(
      near
        ? `Unknown field "${key}" in ${where}. Did you mean "${near}"?`
        : `Unknown field "${key}" in ${where}. Allowed: ${allowed.join(", ")}.`,
      { field: key, allowed }
    );
  }
}

function checkString(value: unknown, where: string): string {
  if (typeof value !== "string") invalid(`${where} must be a string, not ${JSON.stringify(value)}.`);
  if (hasControlChars(value)) invalid(`${where} contains a control character.`);
  return value;
}

function checkBoolean(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") invalid(`${where} must be true or false, not ${JSON.stringify(value)}.`);
  return value;
}

function checkObject(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${where} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function checkType(value: unknown, where: string): CaConfigType {
  if (typeof value !== "string" || !CONFIG_TYPES.has(value as CaConfigType)) {
    invalid(`${where}.type must be one of ${[...CONFIG_TYPES].join(", ")}, not ${JSON.stringify(value)}.`);
  }
  return value as CaConfigType;
}

const PORT_RE = /^\d{1,5}$/;
const validPort = (s: string) => PORT_RE.test(s) && Number(s) >= 1 && Number(s) <= 65535;

/**
 * Check a config entry's target and value for its type.
 *
 * These are the shapes docker itself accepts once Unraid has quoted them. A
 * colon in a path cannot be quoted away: docker splits `-v` on it.
 */
function checkEntryShape(type: CaConfigType, target: string, value: string | undefined, mode: string | undefined, where: string): void {
  switch (type) {
    case "Port":
      if (!validPort(target)) invalid(`${where}.target must be the container port, 1 to 65535.`);
      if (value !== undefined && value !== "" && !validPort(value)) invalid(`${where}.value must be the host port, 1 to 65535.`);
      if (mode !== undefined && !PORT_MODES.has(mode)) invalid(`${where}.mode must be tcp or udp.`);
      break;
    case "Path":
      if (!target.startsWith("/") || target.includes(":")) invalid(`${where}.target must be an absolute container path without ":".`);
      if (value !== undefined && value !== "" && (!value.startsWith("/") || value.includes(":"))) {
        invalid(`${where}.value must be an absolute host path without ":".`);
      }
      if (mode !== undefined && !PATH_MODES.has(mode)) invalid(`${where}.mode must be one of ${[...PATH_MODES].join(", ")}.`);
      break;
    case "Variable":
    case "Label":
      if (target === "" || target.includes("=") || /\s/.test(target)) {
        invalid(`${where}.target must be a ${type === "Variable" ? "variable" : "label"} name without spaces or "=".`);
      }
      if (mode !== undefined && mode !== "") invalid(`${where}.mode is only used for a Port or a Path.`);
      break;
    case "Device":
      if (value !== undefined && !validDevice(value)) {
        invalid(`${where}.value must name a host device under /dev/, such as /dev/ttyUSB0 or /dev/dri. /dev itself would pass every device.`);
      }
      if (mode !== undefined && mode !== "") invalid(`${where}.mode is only used for a Port or a Path.`);
      break;
  }
}

/**
 * Check the template settings an edit passes.
 * Every key must be one an edit may set, and every value plain text.
 */
function parseTemplateSettings(raw: unknown): Partial<Record<TemplateSettingKey, string>> {
  const settings = checkObject(raw, '"settings"');
  const out: Partial<Record<TemplateSettingKey, string>> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!SETTING_SET.has(key)) {
      if (key === "Name") invalid('"settings.Name" cannot be set here: the container name is how the container and its template are found. Renaming is not supported.');
      const near = SETTING_KEYS.find((k) => k.toLowerCase() === key.toLowerCase());
      invalid(
        near ? `Unknown setting "${key}". Did you mean "${near}"?` : `Unknown setting "${key}". Settable: ${SETTING_KEYS.join(", ")}.`,
        { field: key }
      );
    }
    const text = checkString(value, `"settings.${key}"`);
    if (BOOLEAN_SETTINGS.has(key) && text !== "true" && text !== "false") {
      invalid(`"settings.${key}" must be "true" or "false".`);
    }
    if (key === "Repository" && text.trim() === "") invalid('"settings.Repository" cannot be empty: it names the image.');
    // Unraid's xmlToCommand quotes every other value, but passes these two to
    // the shell as they are, so they take the same alphabet as docker create's
    // extraArgs and postArgs. A value already in the template is left alone.
    if ((key === "ExtraParams" || key === "PostArgs") && text !== "" && splitArgs(text) === null) {
      invalid(
        `"settings.${key}" must be docker arguments separated by single spaces, using only letters, digits and : . , / + = _ -, at most ${MAX_ARGS_LENGTH} characters. Unraid hands it to the shell unescaped.`
      );
    }
    out[key as TemplateSettingKey] = text;
  }
  return out;
}

/**
 * Read an edit request by hand, as the other mutating bodies are.
 *
 * Unknown fields are refused rather than ignored, so a typo in a setting name
 * is a 400 that names it instead of an edit that silently changed nothing.
 */
export function parseTemplateEditBody(raw: unknown): TemplateEditRequest {
  const body = checkObject(raw ?? {}, "The request body");
  checkFields(body, BODY_FIELDS, "the request body");
  const out: TemplateEditRequest = {};

  if (body.dryRun !== undefined) out.dryRun = checkBoolean(body.dryRun, '"dryRun"');
  if (body.pull !== undefined) out.pull = checkBoolean(body.pull, '"pull"');

  if (body.settings !== undefined) out.settings = parseTemplateSettings(body.settings);

  if (body.config !== undefined) {
    if (!Array.isArray(body.config)) invalid('"config" must be a list.');
    out.config = body.config.map((item, i) => {
      const where = `config[${i}]`;
      const e = checkObject(item, where);
      checkFields(e, EDIT_FIELDS, where);
      const type = checkType(e.type, where);
      const edit: TemplateConfigEdit = { type, value: checkString(e.value, `${where}.value`) };
      for (const key of ["target", "name", "mode", "default", "description", "display", "replaces"] as const) {
        if (e[key] !== undefined) edit[key] = checkString(e[key], `${where}.${key}`);
      }
      for (const key of ["required", "mask"] as const) {
        if (e[key] !== undefined) edit[key] = checkBoolean(e[key], `${where}.${key}`);
      }
      if (edit.display !== undefined && !DISPLAY_VALUES.has(edit.display)) {
        invalid(`${where}.display must be one of ${[...DISPLAY_VALUES].join(", ")}.`);
      }
      if (type !== "Device" && (edit.target === undefined || edit.target === "")) invalid(`${where}.target is required for a ${type}.`);
      if (type !== "Device" && edit.replaces !== undefined) invalid(`${where}.replaces is only used for a Device.`);
      if (type === "Device" && edit.replaces !== undefined && !edit.replaces.startsWith("/dev")) {
        invalid(`${where}.replaces must be a host device path under /dev/.`);
      }
      checkEntryShape(type, edit.target ?? "", edit.value, edit.mode, where);
      return edit;
    });
  }

  if (body.removeConfig !== undefined) {
    if (!Array.isArray(body.removeConfig)) invalid('"removeConfig" must be a list.');
    out.removeConfig = body.removeConfig.map((item, i) => {
      const where = `removeConfig[${i}]`;
      const r = checkObject(item, where);
      checkFields(r, REF_FIELDS, where);
      const ref: TemplateConfigRef = { type: checkType(r.type, where) };
      for (const key of ["target", "mode", "value"] as const) {
        if (r[key] !== undefined) ref[key] = checkString(r[key], `${where}.${key}`);
      }
      if (ref.type === "Device") {
        if (!ref.value) invalid(`${where}.value is required to remove a Device: the host device path.`);
      } else if (!ref.target) {
        invalid(`${where}.target is required to remove a ${ref.type}.`);
      }
      return ref;
    });
  }

  const count = Object.keys(out.settings ?? {}).length + (out.config?.length ?? 0) + (out.removeConfig?.length ?? 0);
  if (count === 0 && out.pull !== true) invalid('Nothing to change. Pass at least one of "settings", "config" or "removeConfig", or "pull": true to update the image.');
  return out;
}

// ── Reading and writing the template ────────────────────────────

type XmlNode = Record<string, unknown>;

/**
 * Parse a template into the tree an edit works on.
 *
 * The parser keeps the whitespace between elements as text on the parent,
 * because it keeps text exactly as written. That whitespace is layout, not
 * content, and writing it back would leave a growing block of blank lines in
 * the template after every edit.
 */
function readTree(xml: string, path: string): { doc: XmlNode; root: XmlNode } {
  let doc: XmlNode;
  try {
    doc = parseXmlDocument(xml, { alwaysArray: ["Config"] });
  } catch (err) {
    if (err instanceof XmlParseError) {
      throw new CaInstallError(`${path} could not be read: ${err.message}`, "TEMPLATE_UNREADABLE", 422);
    }
    throw err;
  }
  const root = doc.Container;
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    throw new CaInstallError(`${path} has no single <Container> element.`, "TEMPLATE_UNREADABLE", 422);
  }
  const container = root as XmlNode;
  const text = container["#text"];
  if (typeof text === "string" && text.trim() === "") delete container["#text"];
  return { doc, root: container };
}

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  textNodeName: "#text",
  format: true,
  indentBy: "  ",
  suppressEmptyNode: true,
  // The builder's default writes Required="true" as a bare `Required`, which
  // is HTML, not XML, and which neither Unraid nor our own parser accepts.
  suppressBooleanAttributes: false,
});

/**
 * Serialize the tree back to a template.
 *
 * Values are escaped exactly once, which is what Unraid's own postToXML ends up
 * writing and what its xmlToVar reads back. Comments are not kept, as they are
 * not when the Docker tab saves a template either.
 */
function writeTree(doc: XmlNode): string {
  return `<?xml version="1.0"?>\n${String(builder.build(doc)).trimEnd()}\n`;
}

/** The effective value of a config entry, the way xmlToVar reads it. */
function configValue(node: unknown): string {
  const text = textOf(node);
  return text.trim() !== "" ? text : attrOf(node, "Default");
}

function configMode(node: unknown): string {
  const type = attrOf(node, "Type");
  const mode = attrOf(node, "Mode");
  if (type === "Port") return PORT_MODES.has(mode.toLowerCase()) ? mode.toLowerCase() : "tcp";
  if (type === "Path") return PATH_MODES.has(mode.toLowerCase()) ? mode : "rw";
  return mode;
}

function describeEntry(type: string, target: string, mode: string, value: string): string {
  if (type === "Port") return `Port ${target}/${mode || "tcp"}`;
  if (type === "Device") return `Device ${value}`;
  return `${type} ${target}`;
}

function matches(node: unknown, ref: { type: CaConfigType; target?: string; mode?: string; value?: string }): boolean {
  if (attrOf(node, "Type") !== ref.type) return false;
  if (ref.type === "Device") return configValue(node) === ref.value;
  if (attrOf(node, "Target") !== ref.target) return false;
  if (ref.type === "Port") return configMode(node) === (ref.mode ?? "tcp").toLowerCase();
  return true;
}

export interface EditResult {
  xml: string;
  changes: TemplateChange[];
}

/**
 * Apply an edit to a saved template and return the new XML.
 *
 * Only what the request names changes. Every other element and attribute,
 * metadata included, is carried over as it was parsed, so an edit that sets one
 * variable produces a template that differs from the old one in that variable.
 */
export function applyTemplateEdit(xml: string, path: string, edit: TemplateEditRequest): EditResult {
  const { doc, root } = readTree(xml, path);
  const changes: TemplateChange[] = [];

  // Settings. A new element goes in before the first <Config>, where the
  // Docker tab writes the others.
  const additions: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(edit.settings ?? {})) {
    const before = textOf(root[key]);
    if (key in root) {
      const node = root[key];
      if (node !== null && typeof node === "object" && !Array.isArray(node)) {
        (node as XmlNode)["#text"] = value;
      } else {
        root[key] = value;
      }
    } else {
      additions.push([key, value as string]);
    }
    if (before !== value) changes.push({ field: key, before, after: value as string });
  }
  if (additions.length > 0) {
    const entries = Object.entries(root);
    const at = entries.findIndex(([k]) => k === "Config");
    const index = at === -1 ? entries.length : at;
    const reordered = [...entries.slice(0, index), ...additions, ...entries.slice(index)];
    for (const k of Object.keys(root)) delete root[k];
    for (const [k, v] of reordered) root[k] = v;
  }

  let configs = asArray(root.Config as unknown) as XmlNode[];
  const masked = (node: unknown, value: string) => (nodeIsSecret(node) && value !== "" ? "***" : value);

  for (const [i, e] of (edit.config ?? []).entries()) {
    const ref = { type: e.type, target: e.target, mode: e.mode, value: e.type === "Device" ? (e.replaces ?? e.value) : undefined };
    const found = configs.filter((n) => matches(n, ref));
    if (found.length > 1) {
      throw new CaInstallError(
        `config[${i}] matches ${found.length} entries in the template (${describeEntry(e.type, e.target ?? "", e.mode ?? "", ref.value ?? "")}). Remove the duplicate first.`,
        "TEMPLATE_CONFIG_AMBIGUOUS",
        409
      );
    }

    if (found.length === 0) {
      if (e.type === "Device" && e.replaces !== undefined) {
        throw new CaInstallError(`config[${i}] replaces the device "${e.replaces}", which the template does not have.`, "TEMPLATE_CONFIG_NOT_FOUND", 404);
      }
      const mode = e.mode ?? (e.type === "Port" ? "tcp" : e.type === "Path" ? "rw" : "");
      const attrs: Record<string, string> = {
        Name: e.name ?? (e.type === "Device" ? e.value : e.target ?? ""),
        Target: e.type === "Device" ? (e.target ?? "") : (e.target as string),
        Default: e.default ?? "",
        Mode: mode,
        Description: e.description ?? "",
        Type: e.type,
        Display: e.display ?? "always",
        Required: String(e.required ?? false),
        Mask: String(e.mask ?? false),
      };
      const node: XmlNode = {};
      if (e.value !== "") node["#text"] = e.value;
      for (const a of CONFIG_ATTRS) node[`${ATTR_PREFIX}${a}`] = attrs[a];
      configs.push(node);
      changes.push({
        field: describeEntry(e.type, attrs.Target, mode, e.value),
        before: "",
        after: isSecretEntry({ type: e.type, target: attrs.Target, name: attrs.Name, mask: e.mask === true }) && e.value !== "" ? "***" : e.value,
      });
      continue;
    }

    const node = found[0];
    const snapshot = JSON.stringify(node);
    const before = configValue(node);
    const beforeMode = configMode(node);
    const beforeShown = masked(node, before);
    const set = (attr: string, value: string | undefined) => {
      if (value !== undefined) node[`${ATTR_PREFIX}${attr}`] = value;
    };
    set("Name", e.name);
    set("Mode", e.mode);
    set("Description", e.description);
    set("Display", e.display);
    if (e.required !== undefined) set("Required", String(e.required));
    if (e.mask !== undefined) set("Mask", String(e.mask));
    set("Default", e.default);
    // xmlToVar falls back to Default when the text is empty, so clearing a
    // value has to clear its default as well, or the old default comes back.
    if (e.value === "" && e.default === undefined) set("Default", "");
    if (e.value === "") delete node["#text"];
    else node["#text"] = e.value;

    const after = configValue(node);
    const afterMode = configMode(node);
    if (JSON.stringify(node) !== snapshot) {
      // A Path's mode is part of what docker is given, so a change from rw to
      // ro shows up in the values. A Port's mode is part of its field name.
      const withMode = (shown: string, mode: string) => (e.type === "Path" && beforeMode !== afterMode ? `${shown} (${mode})` : shown);
      changes.push({
        field: describeEntry(e.type, attrOf(node, "Target"), e.type === "Port" ? beforeMode : afterMode, e.type === "Device" ? before : after),
        before: withMode(beforeShown, beforeMode),
        after: withMode(masked(node, after), afterMode),
      });
    }
  }

  for (const [i, r] of (edit.removeConfig ?? []).entries()) {
    const found = configs.filter((n) => matches(n, r));
    if (found.length === 0) {
      throw new CaInstallError(
        `removeConfig[${i}] (${describeEntry(r.type, r.target ?? "", r.mode ?? "tcp", r.value ?? "")}) is not in the template.`,
        "TEMPLATE_CONFIG_NOT_FOUND",
        404
      );
    }
    if (found.length > 1) {
      throw new CaInstallError(
        `removeConfig[${i}] matches ${found.length} entries in the template. Remove the duplicate by hand first.`,
        "TEMPLATE_CONFIG_AMBIGUOUS",
        409
      );
    }
    const node = found[0];
    configs = configs.filter((n) => n !== node);
    changes.push({
      field: describeEntry(r.type, attrOf(node, "Target"), configMode(node), configValue(node)),
      before: masked(node, configValue(node)),
      after: "",
    });
  }

  if (configs.length > 0) root.Config = configs;
  else delete root.Config;

  return { xml: writeTree(doc), changes };
}

// ── Viewing ─────────────────────────────────────────────────────

/** Masked, or a variable or label under a secret-looking name such as TUNNEL_TOKEN. */
function nodeIsSecret(node: unknown): boolean {
  return isSecretEntry({ type: attrOf(node, "Type"), target: attrOf(node, "Target"), name: attrOf(node, "Name"), mask: attrOf(node, "Mask") === "true" });
}

/** A template as the Docker tab shows it, with masked and secret-named values hidden. */
export function templateView(xml: string, path: string): TemplateView {
  const { root } = readTree(xml, path);
  const settings: TemplateView["settings"] = {};
  for (const key of SETTING_KEYS) {
    if (key in root) settings[key] = textOf(root[key]);
  }
  const config: TemplateConfigView[] = (asArray(root.Config as unknown) as XmlNode[]).map((node) => {
    const mask = attrOf(node, "Mask") === "true";
    const hidden = nodeIsSecret(node);
    const value = configValue(node);
    return {
      name: attrOf(node, "Name"),
      target: attrOf(node, "Target"),
      type: attrOf(node, "Type"),
      mode: configMode(node),
      value: hidden && value !== "" ? "***" : value,
      default: hidden ? "" : attrOf(node, "Default"),
      description: attrOf(node, "Description"),
      display: attrOf(node, "Display"),
      required: attrOf(node, "Required") === "true",
      mask,
    };
  });
  return { name: textOf(root.Name).trim(), templatePath: path, settings, config };
}
