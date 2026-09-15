// The shared XML reader, which both the docker-template and the .plg paths go
// through. What matters here is what it refuses and what it expands.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { XmlParseError, asArray, attrOf, parseXmlDocument, textOf } from "../src/xml.js";

const here = dirname(fileURLToPath(import.meta.url));

function refuses(xml: string, opts?: Parameters<typeof parseXmlDocument>[1]): XmlParseError {
  try {
    parseXmlDocument(xml, opts);
  } catch (err) {
    if (err instanceof XmlParseError) return err;
    throw err;
  }
  throw new Error("the document was accepted");
}

test("a document type declaration is refused by default", () => {
  const err = refuses(`<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>`);
  assert.equal(err.code, "XML_UNSAFE");
});

test("a processing instruction other than the declaration is refused", () => {
  assert.equal(refuses(`<?xml version="1.0"?><?php echo 1; ?><a/>`).code, "XML_UNSAFE");
});

test("malformed XML is an error, not a half-parsed object", () => {
  assert.equal(refuses("<a><b></a>").code, "XML_INVALID");
});

test("text keeps its own type and predefined entities are decoded", () => {
  const doc = parseXmlDocument(`<a><n>007</n><f>true</f><t>AMD &amp; Intel</t></a>`) as Record<string, unknown>;
  const a = doc.a as Record<string, unknown>;
  assert.equal(a.n, "007");
  assert.equal(a.f, "true");
  assert.equal(a.t, "AMD & Intel");
});

test("a repeated element is a list even when it appears once", () => {
  const doc = parseXmlDocument(`<a><C Target="x">1</C></a>`, { alwaysArray: ["C"] }) as Record<string, unknown>;
  const items = asArray((doc.a as Record<string, unknown>).C);
  assert.equal(items.length, 1);
  assert.equal(attrOf(items[0], "Target"), "x");
  assert.equal(textOf(items[0]), "1");
  assert.equal(textOf(undefined), "");
});

test("a file over the size limit is refused before it is parsed", () => {
  assert.equal(refuses(`<a>${"x".repeat(200)}</a>`, { maxBytes: 100 }).code, "XML_INVALID");
});

// ── Internal entities, which .plg files depend on ───────────────

test("an internal subset is read, and nested entity values are expanded", () => {
  const xml = `<?xml version="1.0"?>
<!DOCTYPE PLUGIN [
<!ENTITY repo "emaspa/thing">
<!ENTITY url  "https://example.invalid/&repo;/x.plg">
]>
<PLUGIN pluginURL="&url;"/>`;
  const doc = parseXmlDocument(xml, { allowInternalEntities: true }) as Record<string, unknown>;
  assert.equal(attrOf(doc.PLUGIN, "pluginURL"), "https://example.invalid/emaspa/thing/x.plg");
});

test("this repo's own plugin file parses, with every entity resolved", async () => {
  const xml = await readFile(join(here, "..", "..", "unraidclaw.plg"), "utf8");
  const doc = parseXmlDocument(xml, { allowInternalEntities: true, alwaysArray: ["FILE"] }) as Record<string, unknown>;
  const plugin = doc.PLUGIN as Record<string, unknown>;
  assert.equal(attrOf(plugin, "name"), "unraidclaw");
  assert.match(attrOf(plugin, "version"), /^\d+\.\d+\.\d+$/);
  assert.match(attrOf(plugin, "pluginURL"), /^https:\/\/raw\.githubusercontent\.com\/emaspa\/unraidclaw\//);
  assert.ok(!JSON.stringify(plugin).includes("&name;"), "no reference is left unexpanded");
  assert.ok(asArray(plugin.FILE).length > 0);
});

test("a CDATA script carrying PHP and an HTML doctype is ordinary text", () => {
  // What a .plg looks like when it installs a web page: the script is INLINE
  // CDATA, and every one of these would be a forbidden declaration if the file
  // were scanned as markup.
  const xml = `<?xml version="1.0"?>
<!DOCTYPE PLUGIN [
<!ENTITY name "demo">
]>
<PLUGIN name="&name;">
<FILE Name="/usr/local/emhttp/plugins/&name;/page.php">
<INLINE><![CDATA[
<?php echo "hi"; ?>
<!DOCTYPE html>
<html><body>&name; &amp; friends</body></html>
]]></INLINE>
</FILE>
</PLUGIN>`;
  const doc = parseXmlDocument(xml, { allowInternalEntities: true, alwaysArray: ["FILE"] }) as Record<string, unknown>;
  const plugin = doc.PLUGIN as Record<string, unknown>;
  assert.equal(attrOf(plugin, "name"), "demo");
  const file = asArray(plugin.FILE)[0] as Record<string, unknown>;
  assert.equal(attrOf(file, "Name"), "/usr/local/emhttp/plugins/demo/page.php");

  const script = textOf(file.INLINE);
  assert.match(script, /<\?php echo "hi"; \?>/);
  assert.match(script, /<!DOCTYPE html>/);
  // A reference inside CDATA is text, not a reference.
  assert.match(script, /&name; &amp; friends/);
});

test("a comment mentioning a doctype does not make the file unsafe", () => {
  const xml = `<?xml version="1.0"?><!-- was <!DOCTYPE x [<!ENTITY y "z">]>, removed --><a>ok</a>`;
  const doc = parseXmlDocument(xml) as Record<string, unknown>;
  assert.equal(doc.a, "ok");
});

test("a real processing instruction outside CDATA is still refused", () => {
  const xml = `<?xml version="1.0"?><a><![CDATA[<?php ok ?>]]></a><?php not ok ?>`;
  assert.equal(refuses(xml).code, "XML_UNSAFE");
});

test("an external entity is refused even with internal entities allowed", () => {
  const xml = `<?xml version="1.0"?><!DOCTYPE p [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><p>&xxe;</p>`;
  assert.equal(refuses(xml, { allowInternalEntities: true }).code, "XML_UNSAFE");
});

test("a parameter entity is refused", () => {
  const xml = `<?xml version="1.0"?><!DOCTYPE p [<!ENTITY % pe "<!ENTITY x 'y'>"> %pe;]><p/>`;
  assert.equal(refuses(xml, { allowInternalEntities: true }).code, "XML_UNSAFE");
});

test("a billion-laughs expansion is refused", () => {
  const levels = Array.from(
    { length: 9 },
    (_, i) => `<!ENTITY lol${i + 1} "${Array(10).fill(i === 0 ? "&lol;" : `&lol${i};`).join("")}">`
  ).join("");
  const xml = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">${levels}]><lolz>&lol9;</lolz>`;
  const err = refuses(xml, { allowInternalEntities: true });
  assert.equal(err.code, "XML_UNSAFE");
  assert.match(err.message, /expands to more than/);
});

test("an entity value with quotes survives being used as an attribute", () => {
  // Substituted carelessly this closes the attribute and the rest becomes new
  // attributes, or the document stops being well-formed.
  const xml = `<?xml version="1.0"?>
<!DOCTYPE P [
<!ENTITY author "A &quot;B&quot; C">
<!ENTITY blurb "it's &author; &amp; co">
]>
<P author="&author;" blurb='&blurb;'><t>&blurb;</t></P>`;
  const doc = parseXmlDocument(xml, { allowInternalEntities: true }) as Record<string, unknown>;
  const p = doc.P as Record<string, unknown>;
  assert.equal(attrOf(p, "author"), 'A "B" C');
  assert.equal(attrOf(p, "blurb"), `it's A "B" C & co`);
  assert.equal(textOf(p.t), `it's A "B" C & co`);
  assert.equal(Object.keys(p).filter((k) => k.startsWith("@_")).length, 2, "no attribute was invented");
});

test("a document repeating an allowed entity past the size limit is refused", () => {
  // Each entity is well under its own cap; the document is not. This is the
  // same expansion attack with the multiplication moved out of the subset.
  const xml = `<?xml version="1.0"?><!DOCTYPE b [<!ENTITY e "${"z".repeat(4096)}">]><b>${"&e;".repeat(400)}</b>`;
  const err = refuses(xml, { allowInternalEntities: true, maxBytes: 512 * 1024 });
  assert.equal(err.code, "XML_UNSAFE");
  assert.match(err.message, /expands to more than/);
  // The same document parses when the ceiling is high enough, so the refusal
  // is the size and not the shape.
  const ok = parseXmlDocument(xml, { allowInternalEntities: true, maxBytes: 4 * 1024 * 1024 }) as Record<string, unknown>;
  assert.equal(textOf(ok.b).length, 4096 * 400);
});

test("an entity that carries markup is refused", () => {
  const xml = `<?xml version="1.0"?><!DOCTYPE p [<!ENTITY evil "<child/>">]><p>&evil;</p>`;
  assert.equal(refuses(xml, { allowInternalEntities: true }).code, "XML_UNSAFE");
});

test("an entity referring to a later one is refused rather than left dangling", () => {
  const xml = `<?xml version="1.0"?><!DOCTYPE p [<!ENTITY a "&b;"><!ENTITY b "x">]><p>&a;</p>`;
  assert.equal(refuses(xml, { allowInternalEntities: true }).code, "XML_UNSAFE");
});
