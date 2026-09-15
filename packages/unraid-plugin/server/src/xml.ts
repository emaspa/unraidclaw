// Strict XML reading for files written by Unraid itself: docker-manager
// templates under /boot/config/plugins/dockerMan, and plugin (.plg) metadata.
//
// Both are read-write by anyone with flash access and can carry third-party
// content, so parsing is deliberately narrow:
//
//   - a document type declaration or an entity declaration is refused before
//     the parser sees it, so no entity expansion of any kind can happen,
//   - a processing instruction other than the XML declaration is refused,
//   - the document is validated before it is parsed, so malformed input is an
//     error rather than a half-parsed object,
//   - text is never coerced to a number or a boolean, so "007" and "true"
//     survive as themselves.
//
// Comments and CDATA are ordinary XML and are accepted; real templates use
// both. Whether the *content* is supported is a separate question, answered by
// each caller's own schema check.

import { XMLParser, XMLValidator } from "fast-xml-parser";

export type XmlErrorCode = "XML_UNSAFE" | "XML_INVALID";

export class XmlParseError extends Error {
  constructor(
    message: string,
    public code: XmlErrorCode
  ) {
    super(message);
    this.name = "XmlParseError";
  }
}

/** Attribute names come back prefixed with this, e.g. `@_Target`. */
export const ATTR_PREFIX = "@_";

const DOCTYPE_RE = /<!DOCTYPE/i;
const ENTITY_DECL_RE = /<!ENTITY/i;
const PI_RE = /<\?([A-Za-z_][\w.:-]*)/g;
const INERT_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g;

/**
 * Blank out comments and CDATA sections, keeping every offset.
 *
 * Nothing inside either is markup, and plugin files rely on that: a .plg that
 * installs a PHP page carries it as an INLINE CDATA script, so "<?php" and
 * "<!DOCTYPE html>" appear in the file as ordinary text. Scanning the raw
 * document for a forbidden declaration would refuse a perfectly normal plugin.
 * The offsets are preserved so a declaration found in the blanked copy can be
 * read out of the real one.
 */
function maskInert(xml: string): string {
  return xml.replace(INERT_RE, (match) => " ".repeat(match.length));
}

/**
 * Allow a `<!DOCTYPE X [ <!ENTITY a "..."> ]>` internal subset.
 *
 * Unraid plugin files need this: every real .plg, including this project's
 * own, declares its name, version and package URL as internal entities and
 * then refers to them from attributes. Refusing the construct outright would
 * refuse nearly every plugin on the system.
 *
 * What is allowed is deliberately narrow, and checked before any parser sees
 * the file:
 *
 *   - one DOCTYPE, with no SYSTEM or PUBLIC identifier, so nothing is ever
 *     fetched from disk or the network,
 *   - an internal subset containing general entity declarations with quoted
 *     literal values, and nothing else: no parameter entities, no ELEMENT,
 *     ATTLIST or NOTATION declarations,
 *   - references inside a value only to entities declared before it, which
 *     makes recursion impossible,
 *   - a bounded number of entities, each with a bounded expanded length, which
 *     is what stops a billion-laughs expansion.
 */
const MAX_ENTITIES = 128;
const MAX_ENTITY_EXPANSION = 64 * 1024;

const ENTITY_DECL = /^\s*<!ENTITY\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s+(?:"([^"]*)"|'([^']*)')\s*>/;
const DOCTYPE_DECL = /^<!DOCTYPE\s+[A-Za-z_][A-Za-z0-9_.:-]*\s*(?:\[([\s\S]*?)\]\s*)?>/;
const REFERENCE = /&([^;&\s]+);/g;
const PREDEFINED = new Set(["lt", "gt", "amp", "quot", "apos"]);

interface InternalSubset {
  /** Where the DOCTYPE declaration starts and ends in the document. */
  start: number;
  end: number;
  /** Entity values with every nested reference already resolved. */
  resolved: Map<string, string>;
}

/**
 * Check the internal subset and resolve its entities.
 *
 * The values are expanded here rather than left to the parser, which silently
 * drops any entity whose value refers to another one. Every real .plg does
 * that (`pluginURL` is built from `repo`), and a silently unexpanded
 * `&pluginURL;` would be handed on as if it were a URL.
 */
function readInternalSubset(xml: string, inert: string): InternalSubset | null {
  const start = inert.search(DOCTYPE_RE);
  if (start === -1) return null;
  if (inert.slice(start + 1).search(DOCTYPE_RE) !== -1) {
    throw new XmlParseError("The file has more than one DOCTYPE declaration.", "XML_UNSAFE");
  }

  const match = DOCTYPE_DECL.exec(xml.slice(start));
  if (!match) {
    throw new XmlParseError(
      "The DOCTYPE declaration is not a plain internal subset, so it may pull in an external file.",
      "XML_UNSAFE"
    );
  }

  let rest = (match[1] ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const resolved = new Map<string, string>();

  while (rest.trim() !== "") {
    const decl = ENTITY_DECL.exec(rest);
    if (!decl) {
      throw new XmlParseError(
        `The DOCTYPE declares something other than a plain entity: ${rest.trim().slice(0, 60)}`,
        "XML_UNSAFE"
      );
    }
    const name = decl[1];
    const value = decl[2] ?? decl[3] ?? "";
    if (resolved.has(name)) {
      throw new XmlParseError(`The DOCTYPE declares the entity "${name}" twice.`, "XML_UNSAFE");
    }
    if (resolved.size >= MAX_ENTITIES) {
      throw new XmlParseError(`The DOCTYPE declares more than ${MAX_ENTITIES} entities.`, "XML_UNSAFE");
    }
    // An entity that carries markup would let the subset rewrite the document
    // it is declared in. Values here are text.
    if (value.includes("<")) {
      throw new XmlParseError(`The entity "${name}" contains markup.`, "XML_UNSAFE");
    }

    // Each reference can only point at an entity declared before this one, so
    // one pass resolves the value completely and recursion cannot arise. The
    // length cap is what a nesting attack runs into.
    let expanded = "";
    let cursor = 0;
    for (const ref of value.matchAll(REFERENCE)) {
      const target = ref[1];
      if (target.startsWith("#") || PREDEFINED.has(target)) continue;
      const known = resolved.get(target);
      if (known === undefined) {
        throw new XmlParseError(
          `The entity "${name}" refers to "${target}", which is not declared before it.`,
          "XML_UNSAFE"
        );
      }
      expanded += value.slice(cursor, ref.index) + known;
      cursor = ref.index + ref[0].length;
      if (expanded.length > MAX_ENTITY_EXPANSION) {
        throw new XmlParseError(`The entity "${name}" expands to more than ${MAX_ENTITY_EXPANSION} bytes.`, "XML_UNSAFE");
      }
    }
    expanded += value.slice(cursor);
    if (expanded.length > MAX_ENTITY_EXPANSION) {
      throw new XmlParseError(`The entity "${name}" expands to more than ${MAX_ENTITY_EXPANSION} bytes.`, "XML_UNSAFE");
    }

    resolved.set(name, expanded);
    rest = rest.slice(decl[0].length);
  }

  return { start, end: start + match[0].length, resolved };
}

const NAMED = new Map([["lt", "<"], ["gt", ">"], ["amp", "&"], ["quot", '"'], ["apos", "'"]]);

/** Turn the predefined entities and numeric references in a value into text. */
function decodeBuiltins(s: string): string {
  return s.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED.get(body) ?? whole;
  });
}

function escapeAll(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// A comment, a CDATA section, or an entity reference. The first two are copied
// through untouched: XML does not expand references inside either, and pasting
// a value into a comment would change what the document says.
const SUBSTITUTION = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|&([^;&\s<]+);/g;

/**
 * Put the resolved entity values into the document, encoded so that the parser
 * reads back exactly the declared value.
 *
 * Each value is escaped before it goes in. A legal `<!ENTITY author 'A "B"'>`
 * used as `author="&author;"` would otherwise close the attribute and turn the
 * rest into new attributes; escaping makes the substitution mean the same thing
 * in an attribute and in text, which is what XML says a reference does.
 *
 * The size ceiling is checked as the document is built rather than afterwards:
 * the per-entity cap says nothing about a document that refers to an allowed
 * entity ten thousand times, which is the same attack with the multiplication
 * moved out of the subset.
 */
function substituteEntities(body: string, resolved: Map<string, string>, limit: number): string {
  const encoded = new Map<string, string>();
  for (const [name, value] of resolved) encoded.set(name, escapeAll(decodeBuiltins(value)));

  let out = "";
  let cursor = 0;
  for (const match of body.matchAll(SUBSTITUTION)) {
    const name = match[1];
    const replacement = name === undefined ? match[0] : encoded.get(name) ?? match[0];
    out += body.slice(cursor, match.index) + replacement;
    cursor = match.index + match[0].length;
    if (out.length > limit) {
      throw new XmlParseError(`The file expands to more than ${limit} bytes.`, "XML_UNSAFE");
    }
  }
  out += body.slice(cursor);
  if (out.length > limit) {
    throw new XmlParseError(`The file expands to more than ${limit} bytes.`, "XML_UNSAFE");
  }
  return out;
}

export interface XmlParseOptions {
  /**
   * Tag names that must always come back as an array, even when the document
   * happens to contain exactly one of them. Without this a template with a
   * single `<Config>` and a template with several parse to different shapes,
   * and one of the two paths goes untested.
   */
  alwaysArray?: readonly string[];
  /** Refuse anything larger, before parsing. Default 4 MiB. */
  maxBytes?: number;
  /**
   * Accept a bounded `<!DOCTYPE X [ <!ENTITY ... > ]>` internal subset, which
   * Unraid plugin files depend on. Off by default: a docker template has no
   * business declaring entities.
   */
  allowInternalEntities?: boolean;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** Parse one XML document into a plain object. */
export function parseXmlDocument(xml: string, opts: XmlParseOptions = {}): Record<string, unknown> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const size = Buffer.byteLength(xml, "utf8");
  if (size > maxBytes) {
    throw new XmlParseError(`The file is ${size} bytes, over the ${maxBytes} byte limit.`, "XML_INVALID");
  }
  let document = xml;
  const inert = maskInert(xml);
  if (opts.allowInternalEntities) {
    const subset = readInternalSubset(xml, inert);
    if (subset) {
      // The declaration itself is dropped and the values are handed to the
      // parser instead of pasted into the source. Substituting into the text
      // would rewrite the document: a legal <!ENTITY author 'A "B"'> used as
      // author="&author;" turns into new attributes, and a reference inside a
      // comment or CDATA would expand where XML says it must not.
      document = substituteEntities(
        xml.slice(0, subset.start) + xml.slice(subset.end),
        subset.resolved,
        maxBytes
      );
    }
  } else {
    if (DOCTYPE_RE.test(inert)) {
      throw new XmlParseError("The file carries a DOCTYPE declaration, which is not allowed here.", "XML_UNSAFE");
    }
    if (ENTITY_DECL_RE.test(inert)) {
      throw new XmlParseError("The file declares XML entities, which are not allowed here.", "XML_UNSAFE");
    }
  }
  for (const match of maskInert(document).matchAll(PI_RE)) {
    if (match[1].toLowerCase() !== "xml") {
      throw new XmlParseError(
        `The file carries a "<?${match[1]}" processing instruction, which is not allowed here.`,
        "XML_UNSAFE"
      );
    }
  }

  const verdict = XMLValidator.validate(document, { allowBooleanAttributes: false });
  if (verdict !== true) {
    throw new XmlParseError(
      `The file is not well-formed XML: ${verdict.err.msg} (line ${verdict.err.line}).`,
      "XML_INVALID"
    );
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTR_PREFIX,
    parseTagValue: false,
    parseAttributeValue: false,
    // Saved values are kept exactly as written. A path or a variable with a
    // trailing space is a configuration someone chose, and an update that
    // trimmed it would hand the app a different value than it has been running
    // with. Callers trim the metadata fields where trimming is right.
    trimValues: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    processEntities: true,
    htmlEntities: false,
    isArray: (name) => (opts.alwaysArray ?? []).includes(name),
  });

  try {
    return parser.parse(document) as Record<string, unknown>;
  } catch (err) {
    throw new XmlParseError(`The file could not be parsed: ${(err as Error).message}`, "XML_INVALID");
  }
}

/** One value or many, always as a list. Absent becomes the empty list. */
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * The text of an element, whatever shape the parser gave it.
 *
 * `<X/>` and `<X></X>` are both the empty string; an element carrying
 * attributes keeps its text under `#text`.
 */
export function textOf(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (typeof node === "object") {
    const text = (node as Record<string, unknown>)["#text"];
    return text === undefined || text === null ? "" : String(text);
  }
  return "";
}

/** The value of an attribute, or the empty string when it is absent. */
export function attrOf(node: unknown, name: string): string {
  if (node === null || typeof node !== "object") return "";
  const value = (node as Record<string, unknown>)[`${ATTR_PREFIX}${name}`];
  return value === undefined || value === null ? "" : String(value);
}
