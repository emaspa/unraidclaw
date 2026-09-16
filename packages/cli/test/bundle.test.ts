import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { childOutput, fixture } from "./helpers.js";

test("the CommonJS bundle runs outside the checkout without node_modules", async t => {
  const { dir } = await fixture(t);
  const path = join(dir, "unraidclaw.cjs");
  await copyFile(new URL("../dist/unraidclaw.cjs", import.meta.url), path);
  assert.ok((await readFile(path, "utf8")).startsWith("#!/usr/bin/env node\n"));
  const version = await childOutput(dir, process.execPath, [path, "--version"]);
  assert.equal(version.code, 0);
  // Release builds stamp their own version into the bundle.
  assert.match(version.stdout, /^unraidclaw \d+\.\d+\.\d+\S*\n$/);
  const tools = await childOutput(dir, process.execPath, [path, "tools", "--output", "json"]);
  assert.equal(JSON.parse(tools.stdout).length, 55);
  const help = await childOutput(dir, process.execPath, [path, "docker", "--help"]);
  assert.match(help.stdout, /docker inspect/);
  const invalid = await childOutput(dir, process.execPath, [path, "unknown-command"]);
  assert.equal(invalid.code, 2);
  assert.equal(invalid.stdout, "");
});
