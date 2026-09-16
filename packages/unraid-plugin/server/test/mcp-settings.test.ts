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
const command = join(flash, "command.txt");

// Run the real handler with a temporary cfg, a namespaced fake exec and no
// sleep. No service command can escape this fixture, including on failure paths.
async function settingsScript(): Promise<string> {
  const source = await readFile(new URL("../../src/usr/local/emhttp/plugins/unraidclaw/php/save-settings.php", import.meta.url), "utf8");
  const fixture = source.replace("<?php", `<?php
namespace McpSettingsFixture;
function exec($command, &$output = null, &$code = null) {
    file_put_contents(getenv('MCP_TEST_COMMAND'), $command . "\\n", FILE_APPEND);
    $output = [str_ends_with($command, ' status 2>&1') ? (getenv('MCP_TEST_STATE') ?: 'running') : 'fixture'];
    $code = 0;
}
function usleep($microseconds) {}
$_GET = json_decode(getenv('MCP_TEST_INPUT'), true);
$_POST = [];
`).replace('$cfgFile = "/boot/config/plugins/{$plugin}/unraidclaw.cfg";', "$cfgFile = getenv('MCP_TEST_CFG');");
  const script = join(flash, "settings.php");
  await writeFile(script, fixture);
  return script;
}

function save(script: string, input: Record<string, unknown>, env: Record<string, string> = {}) {
  const result = spawnSync("php", [script], { encoding: "utf8", env: { ...process.env, MCP_TEST_CFG: cfgFile, MCP_TEST_COMMAND: command, MCP_TEST_INPUT: JSON.stringify({ ajax: "1", ...input }), ...env } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("settings PHP rejects malformed MCP values before writes/restarts and persists yes/no", { skip: !phpAvailable && "PHP CLI unavailable" }, async () => {
  const script = await settingsScript();
  for (const value of ["yes", "no", "true", "YES", "", ["yes"], true, null, 'yes"\nSERVICE="enable']) {
    await writeFile(cfgFile, 'SERVICE="enable"\nMCP_ENABLED="no"\n');
    await rm(command, { force: true });
    const output = save(script, { MCP_ENABLED: value });
    const valid = value === "yes" || value === "no";
    assert.equal(output.success, valid);
    if (valid) {
      assert.match(await readFile(cfgFile, "utf8"), new RegExp(`MCP_ENABLED="${value}"`));
      assert.equal(await readFile(command, "utf8"), "/etc/rc.d/rc.unraidclaw restart 2>&1\n/etc/rc.d/rc.unraidclaw status 2>&1\n");
    } else {
      assert.equal(await readFile(cfgFile, "utf8"), 'SERVICE="enable"\nMCP_ENABLED="no"\n');
      await assert.rejects(readFile(command), { code: "ENOENT" });
    }
  }
});

test("settings PHP reports a service that is not in the requested state and skips the service when the cfg cannot be written", { skip: !phpAvailable && "PHP CLI unavailable" }, async () => {
  const script = await settingsScript();
  await writeFile(cfgFile, 'SERVICE="enable"\n');
  await rm(command, { force: true });
  const died = save(script, { MCP_ENABLED: "no" }, { MCP_TEST_STATE: "stopped" });
  assert.equal(died.success, false);
  assert.equal(died.saved, true);
  assert.equal(died.serviceState, "stopped");
  assert.match(died.error, /not running/);

  await writeFile(cfgFile, 'SERVICE="enable"\n');
  const stopped = save(script, { SERVICE: "disable" }, { MCP_TEST_STATE: "stopped" });
  assert.equal(stopped.success, true);
  const stuck = save(script, { SERVICE: "disable" }, { MCP_TEST_STATE: "running" });
  assert.equal(stuck.success, false);
  assert.match(stuck.error, /did not stop/);

  await rm(command, { force: true });
  const unwritable = save(script, { MCP_ENABLED: "no" }, { MCP_TEST_CFG: join(cfgFile, "unraidclaw.cfg") });
  assert.equal(unwritable.success, false);
  assert.equal(unwritable.saved, false);
  assert.match(unwritable.error, /service was not changed/);
  await assert.rejects(readFile(command), { code: "ENOENT" });
});
