import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const flash = await mkdtemp(join(tmpdir(), "unraidclaw-mcp-settings-"));
process.env.FLASH_BASE = flash;
const { loadConfig } = await import("../src/config.js");
const cfgFile = join(flash, "unraidclaw.cfg");
after(async () => { delete process.env.OCC_MCP_ENABLED; await rm(flash, { recursive: true, force: true }); });

test("MCP config is opt-in, accepts only yes, and cfg takes precedence over env", async () => {
  delete process.env.OCC_MCP_ENABLED;
  assert.equal(loadConfig().mcpEnabled, false);
  for (const value of ["yes", "no", "true", "1", "YES", ""]) {
    process.env.OCC_MCP_ENABLED = value;
    assert.equal(loadConfig().mcpEnabled, value === "yes");
  }
  process.env.OCC_MCP_ENABLED = "yes";
  await writeFile(cfgFile, 'MCP_ENABLED="no"\n');
  assert.equal(loadConfig().mcpEnabled, false);
  process.env.OCC_MCP_ENABLED = "no";
  await writeFile(cfgFile, 'MCP_ENABLED="yes"\n');
  assert.equal(loadConfig().mcpEnabled, true);
  await writeFile(cfgFile, 'MCP_ENABLED="invalid"\n');
  assert.equal(loadConfig().mcpEnabled, false);
});

test("WebGUI and service wiring keep MCP off by default and retain GET settings submission", async () => {
  const base = new URL("../../src/usr/local/emhttp/plugins/unraidclaw/", import.meta.url);
  assert.match(await readFile(new URL("default.cfg", base), "utf8"), /^MCP_ENABLED="no"$/m);
  const page = await readFile(new URL("unraidclaw.page", base), "utf8");
  assert.match(page, /<select name="MCP_ENABLED">[\s\S]*?<option value="no"[\s\S]*?<option value="yes"/);
  assert.match(page, /Expose MCP at \/mcp/);
  assert.match(await readFile(new URL("../../rc.d/rc.unraidclaw", import.meta.url), "utf8"), /export OCC_MCP_ENABLED="\$\{MCP_ENABLED:-no\}"/);
  assert.match(await readFile(new URL("javascript/unraidclaw.js", base), "utf8"), /save-settings\.php\?/);
});

const phpAvailable = spawnSync("php", ["-v"], { encoding: "utf8" }).status === 0;
test("settings PHP rejects malformed MCP values before writes/restarts and persists yes/no", { skip: !phpAvailable && "PHP CLI unavailable" }, async () => {
  const source = await readFile(new URL("../../src/usr/local/emhttp/plugins/unraidclaw/php/save-settings.php", import.meta.url), "utf8");
  // Run the real handler with a temporary cfg and a namespaced fake exec.
  // No service command can escape this fixture, including on failure paths.
  const fixture = source.replace("<?php", `<?php
namespace McpSettingsFixture;
function exec($command, &$output, &$code) {
    file_put_contents(getenv('MCP_TEST_COMMAND'), $command);
    $output = ['fixture'];
    $code = 0;
}
$_GET = json_decode(getenv('MCP_TEST_INPUT'), true);
$_POST = [];
`).replace('$cfgFile = "/boot/config/plugins/{$plugin}/unraidclaw.cfg";', "$cfgFile = getenv('MCP_TEST_CFG');");
  const script = join(flash, "settings.php");
  const command = join(flash, "command.txt");
  await writeFile(script, fixture);
  for (const value of ["yes", "no", "true", "YES", "", ["yes"], true, null, 'yes"\nSERVICE="enable']) {
    await writeFile(cfgFile, 'SERVICE="enable"\nMCP_ENABLED="no"\n');
    await rm(command, { force: true });
    const result = spawnSync("php", [script], { encoding: "utf8", env: { ...process.env, MCP_TEST_CFG: cfgFile, MCP_TEST_COMMAND: command, MCP_TEST_INPUT: JSON.stringify({ ajax: "1", MCP_ENABLED: value }) } });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    const valid = value === "yes" || value === "no";
    assert.equal(output.success, valid);
    if (valid) {
      assert.match(await readFile(cfgFile, "utf8"), new RegExp(`MCP_ENABLED="${value}"`));
      assert.equal(await readFile(command, "utf8"), "/etc/rc.d/rc.unraidclaw restart 2>&1");
    } else {
      assert.equal(await readFile(cfgFile, "utf8"), 'SERVICE="enable"\nMCP_ENABLED="no"\n');
      await assert.rejects(readFile(command), { code: "ENOENT" });
    }
  }
});
