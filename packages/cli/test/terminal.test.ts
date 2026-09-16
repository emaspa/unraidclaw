import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Configuration } from "../src/config.js";
import { Secrets } from "../src/errors.js";
import { childOutput, fixture, randomKey } from "./helpers.js";

const child = fileURLToPath(new URL("terminal-child.ts", import.meta.url));
const loader = import.meta.resolve("tsx");

test("config set-key consumes real stdin without printing it, including invalid multiline input", async t => {
  const { dir, context } = await fixture(t);
  const key = randomKey();
  const command = ["--import", loader, child, dir];
  const result = await childOutput(dir, process.execPath, command, key + "\n");
  assert.equal(result.code, 0);
  assert.ok(!(result.stdout + result.stderr).includes(key));
  const config = await Configuration.load({}, context, new Secrets());
  assert.ok(JSON.parse(await readFile(config.path, "utf8")).key === key);
  const invalid = await childOutput(dir, process.execPath, command, key + "\n" + randomKey());
  assert.equal(invalid.code, 2);
  assert.ok(!(invalid.stdout + invalid.stderr).includes(key));
});

test("config set-key hides input in a real terminal", async t => {
  if (process.platform === "win32") { t.skip("POSIX pseudo-terminal test"); return; }
  const { dir } = await fixture(t);
  const key = randomKey();
  let result;
  try {
    result = await childOutput(dir, "python3", [fileURLToPath(new URL("hidden-prompt.py", import.meta.url))], JSON.stringify({
      command: [process.execPath, "--import", loader, child, dir], cwd: dir, key,
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { t.skip("python3 unavailable for the pseudo-terminal fixture"); return; }
    throw error;
  }
  assert.equal(result.code, 0);
  assert.ok(!(result.stdout + result.stderr).includes(key));
  const status = JSON.parse(result.stdout);
  if (status.skipped) { t.skip(status.skipped); return; }
  assert.deepEqual(status, { code: 0, prompted: true, echoed: false, saved: true });
});
