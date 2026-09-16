import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Configuration, parseCfg, remoteConfigPath } from "../src/config.js";
import { Secrets } from "../src/errors.js";
import { capture, fixture, randomKey, recordingClient } from "./helpers.js";

test("configuration precedence is flags, environment, file, then fixture Unraid defaults", async t => {
  const { dir, context } = await fixture(t);
  const base = join(dir, "boot/config/plugins/unraidclaw");
  await mkdir(join(base, "tls"), { recursive: true });
  await writeFile(join(base, "unraidclaw.cfg"), '# fixture\nPORT="12345"\nHOST="ignored"\n$(touch forbidden)\n');
  const local = await Configuration.load({}, context, new Secrets());
  assert.equal(local.path, join(base, "cli.json"));
  assert.equal(local.settings.url, "http://127.0.0.1:12345");
  await writeFile(join(base, "tls/cert.pem"), "fixture public certificate");
  const tls = await Configuration.load({}, context, new Secrets());
  assert.equal(tls.settings.url, "https://127.0.0.1:12345");
  assert.equal(tls.settings.caCert, join(base, "tls/cert.pem"));
  assert.equal(tls.settings.key, undefined);
  const fileKey = randomKey(), envKey = randomKey(), flagKey = randomKey();
  await tls.save({ url: "https://file.invalid:9876", key: fileKey, caCert: "file.pem", insecure: true });
  const file = await Configuration.load({}, context, new Secrets());
  assert.equal(file.settings.url, "https://file.invalid:9876");
  assert.ok(file.settings.key === fileKey);
  Object.assign(context.env, { UNRAIDCLAW_URL: "https://env.invalid:9876", UNRAIDCLAW_KEY: envKey, UNRAIDCLAW_CA_CERT: "env.pem", UNRAIDCLAW_INSECURE: "false" });
  const env = await Configuration.load({}, context, new Secrets());
  assert.equal(env.settings.url, "https://env.invalid:9876");
  assert.equal(env.settings.insecure, false);
  assert.equal(env.settings.caCert, "env.pem");
  assert.ok(env.settings.key === envKey);
  const flags = await Configuration.load({ url: "https://flags.invalid:9876", key: flagKey, caCert: "flags.pem", insecure: false }, context, new Secrets());
  assert.equal(flags.settings.url, "https://flags.invalid:9876");
  assert.equal(flags.settings.caCert, "flags.pem");
  assert.equal(flags.settings.insecure, false);
  assert.ok(flags.settings.key === flagKey);
});

test("local cfg is data only, defaults its port, and refuses malformed ports", async t => {
  const { dir, context } = await fixture(t);
  const base = join(dir, "boot/config/plugins/unraidclaw");
  await mkdir(base, { recursive: true });
  const path = join(base, "unraidclaw.cfg");
  await writeFile(path, 'HOST="localhost"\nPORT=4567\n');
  assert.equal((await Configuration.load({}, context, new Secrets())).settings.url, "http://127.0.0.1:9876");
  assert.deepEqual({ ...parseCfg('PORT="1234"\nsource /other\nPORT="5"; touch /other\n') }, { PORT: "1234" });
  await writeFile(path, 'PORT="$(touch forbidden)"\n');
  await assert.rejects(Configuration.load({}, context, new Secrets()), /PORT/);
});

test("default remote paths and env TLS alias are respected without a local CA for a remote URL", async t => {
  const { dir, context } = await fixture(t);
  assert.equal((await Configuration.load({}, context, new Secrets())).path, remoteConfigPath(context));
  context.env.XDG_CONFIG_HOME = join(dir, "xdg");
  context.env.UNRAIDCLAW_TLS_SKIP = "yes";
  assert.equal((await Configuration.load({}, context, new Secrets())).path, remoteConfigPath(context));
  assert.equal((await Configuration.load({}, context, new Secrets())).settings.insecure, true);
  context.env.UNRAIDCLAW_INSECURE = "no";
  assert.equal((await Configuration.load({}, context, new Secrets())).settings.insecure, false);
  assert.equal((await Configuration.load({ insecure: true }, context, new Secrets())).settings.insecure, true);
  const base = join(dir, "boot/config/plugins/unraidclaw");
  await mkdir(join(base, "tls"), { recursive: true });
  await writeFile(join(base, "tls/cert.pem"), "fixture public certificate");
  await writeFile(join(base, "unraidclaw.cfg"), "");
  assert.equal((await Configuration.load({ url: "https://remote.invalid" }, context, new Secrets())).settings.caCert, undefined);
});

test("Windows uses APPDATA or its home fallback, and POSIX uses XDG or .config", () => {
  const windows = { root: "/", home: "C:\\Users\\fixture", platform: "win32" as const, env: {} };
  assert.equal(remoteConfigPath(windows), "C:\\Users\\fixture\\AppData\\Roaming\\unraidclaw\\config.json");
  assert.equal(remoteConfigPath({ ...windows, env: { APPDATA: "D:\\Settings", XDG_CONFIG_HOME: "ignored" } }), "D:\\Settings\\unraidclaw\\config.json");
  for (const platform of ["linux", "darwin"] as const) {
    const posix = { root: "/", home: "/users/fixture", platform, env: {} };
    assert.equal(remoteConfigPath(posix), join("/users/fixture", ".config/unraidclaw/config.json"));
    assert.equal(remoteConfigPath({ ...posix, env: { XDG_CONFIG_HOME: "/fixture/xdg" } }), join("/fixture/xdg", "unraidclaw/config.json"));
  }
});

test("POSIX permissions are private on writes and checked on reads, with Windows and flash exceptions", async t => {
  if (process.platform === "win32") { t.skip("POSIX modes are not available on Windows"); return; }
  const { dir, context } = await fixture(t);
  const secrets = new Secrets();
  const config = await Configuration.load({}, context, secrets);
  await config.save({ key: randomKey() });
  assert.equal((await stat(config.path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(config.path))).mode & 0o777, 0o700);
  await chmod(config.path, 0o644);
  await assert.rejects(Configuration.load({}, context, secrets), /chmod 600/);
  const windows = await Configuration.load({ config: config.path }, { ...context, platform: "win32" }, secrets);
  assert.ok(windows.file.key);
  await chmod(config.path, 0o600);
  await symlink(config.path, join(dir, "linked.json"));
  await assert.rejects(Configuration.load({ config: join(dir, "linked.json") }, context, secrets), /symlinks/);
  const base = join(dir, "boot/config/plugins/unraidclaw");
  await mkdir(base, { recursive: true });
  await writeFile(join(base, "unraidclaw.cfg"), "");
  await writeFile(join(base, "cli.json"), JSON.stringify({ key: randomKey() }), { mode: 0o644 });
  assert.ok((await Configuration.load({}, context, secrets)).file.key);
  const loose = join(dir, "loose");
  await mkdir(loose, { mode: 0o755 });
  const unsafe = await Configuration.load({ config: join(loose, "config.json") }, context, secrets);
  await assert.rejects(unsafe.save({ key: randomKey() }), /chmod 700/);
});

test("config commands mask keys and generic failures do not echo secrets", async t => {
  const { dir, context } = await fixture(t);
  const cli = capture(context, () => recordingClient().client);
  const key = randomKey();
  cli.io.readKey = async () => key;
  assert.equal((await cli.run(["config", "set-key", "--output", "json"])).code, 0);
  const config = await Configuration.load({}, context, new Secrets());
  assert.ok(JSON.parse(await readFile(config.path, "utf8")).key === key);
  for (const argv of [
    ["config", "show"], ["config", "show", "--output", "json"], ["config", "path"],
    ["config", "set", "url", "https://127.0.0.1:9876"],
    ["config", "set", "ca-cert", join(dir, key)],
    ["config", "set", "insecure", "false"], ["config", "set", "key", key],
    ["config", "set", "url", `https://${key}@127.0.0.1`],
    ["config", "set-key", key], ["config", "set-key", "--output", "json"],
  ]) {
    const result = await cli.run(argv);
    assert.ok(!(result.stdout + result.stderr).includes(key), "config output must not expose the key");
  }
  const shown = await cli.run(["config", "show", "--output", "json"]);
  assert.equal(JSON.parse(shown.stdout).key, "[redacted]");
  const empty = await cli.run(["--config", join(dir, "unset.json"), "config", "show"]);
  assert.equal(empty.stdout, "url: (not set)\nkey: (not set)\ncaCert: (not set)\ninsecure: false\n");
  const flagKey = randomKey();
  const warned = await cli.run(["--key", flagKey, "config", "show"]);
  assert.match(warned.stderr, /process list/);
  assert.ok(!(warned.stdout + warned.stderr).includes(flagKey));
  await writeFile(config.path, JSON.stringify({ key, unexpected: key }));
  const invalid = await cli.run(["config", "show"]);
  assert.equal(invalid.code, 2);
  assert.ok(!(invalid.stdout + invalid.stderr).includes(key));
});

test("credentials echoed by a tool are redacted in JSON, plain output, and confirmations", async t => {
  const { context } = await fixture(t);
  const key = randomKey();
  context.env.UNRAIDCLAW_KEY = key;
  context.env.UNRAIDCLAW_URL = "https://127.0.0.1:9876";
  const cli = capture(context, () => recordingClient().client);
  for (const output of ["table", "json"]) {
    const result = await cli.run(["docker", "inspect", key, "--output", output]);
    assert.equal(result.code, 0);
    assert.ok(!(result.stdout + result.stderr).includes(key));
    if (output === "json") assert.ok(JSON.parse(result.stdout));
    const refused = await cli.run(["docker", "remove", key, "--output", output]);
    assert.ok(!(refused.stdout + refused.stderr).includes(key));
  }
});
