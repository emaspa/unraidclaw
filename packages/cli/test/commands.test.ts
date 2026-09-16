import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerTools, READ_ONLY, type ToolDefinition } from "unraidclaw/tools";
import { commands, aliases, parse, argumentsFor, help, kebab } from "../src/commands.js";
import { capture, fixture, randomKey, recordingClient } from "./helpers.js";

const catalog = commands(recordingClient().client);
const args = (argv: string[]) => argumentsFor(parse(argv, catalog));

test("every tool has one unique derived command, shared read-only status and no server parameter", () => {
  const tools: ToolDefinition[] = [];
  registerTools({ registerTool: tool => { tools.push(tool); } }, () => recordingClient().client);
  assert.equal(catalog.length, 55);
  assert.equal(catalog.length, tools.length);
  assert.equal(new Set(catalog.map(command => command.name)).size, 55);
  assert.deepEqual(catalog.map(command => command.tool.name).sort(), tools.map(tool => tool.name).sort());
  for (const command of catalog) {
    assert.equal(command.readOnly, READ_ONLY.has(command.tool.name));
    assert.ok(!Object.hasOwn(command.schema.properties, "server"));
    assert.ok(!command.schema.required?.includes("server"));
    assert.equal(parse(command.name.split(" "), catalog).command, command);
    assert.ok(!help(catalog, command.name.split(" ")).includes("--server"));
  }
  for (const [alias, original] of Object.entries(aliases)) {
    assert.equal(parse(alias.split(" "), catalog).command?.name, original);
  }
});

test("positional targets, numeric flags, booleans, arrays and JSON objects follow the schema", async () => {
  assert.deepEqual(await args(["docker", "inspect", "fixture"]), { id: "fixture" });
  assert.deepEqual(await args(["docker", "inspect", "--id", "fixture"]), { id: "fixture" });
  assert.deepEqual(await args(["docker", "logs", "fixture", "--tail", "20"]), { id: "fixture", tail: 20 });
  assert.deepEqual(await args(["docker", "remove", "fixture", "--no-force"]), { id: "fixture", force: false });
  assert.deepEqual(await args(["docker", "remove", "fixture", "--force"]), { id: "fixture", force: true });
  assert.deepEqual(await args(["docker", "create", "--image", "fixture:latest", "--ports", "80:80", "--ports", "81:81", "--restart", "no"]),
    { image: "fixture:latest", ports: ["80:80", "81:81"], restart: "no" });
  assert.deepEqual(await args(["ca", "install", "fixture", "--overrides", '{"PUID":"99"}', "--dry-run"]),
    { name: "fixture", overrides: { PUID: "99" }, dryRun: true });
  assert.deepEqual(await args(["plugin", "info", "fixture.plg"]), { plugin: "fixture.plg" });
});

test("complex arrays accept JSON, including nested schema validation", async () => {
  const command = catalog.find(command => command.name === "ca install")!;
  const schema = { type: "array", items: { type: "object", properties: { size: { type: "integer" } }, required: ["size"], additionalProperties: false } };
  // An isolated synthetic registration checks support for future registry schemas.
  const { default: Ajv } = await import("ajv");
  const synthetic = { ...command, schema: { ...command.schema, properties: { entries: schema }, required: ["entries"] } };
  synthetic.validate = new Ajv().compile(synthetic.schema);
  assert.deepEqual(await argumentsFor(parse(["ca", "install", "--entries", '[{"size":2}]'], [synthetic])), { entries: [{ size: 2 }] });
  await assert.rejects(argumentsFor(parse(["ca", "install", "--entries", '[{"size":"bad"}]'], [synthetic])), /Invalid arguments/);
});

test("args-json reads files and named flags override its values", async t => {
  const { dir } = await fixture(t);
  const path = join(dir, "args.json");
  await writeFile(path, JSON.stringify({ id: "fixture", tail: 10 }));
  assert.deepEqual(await args(["docker", "logs", "--args-json", `@${path}`, "--tail", "30"]), { id: "fixture", tail: 30 });
  await assert.rejects(args(["docker", "logs", "--args-json", "[]"]), /must contain an object/);
  await assert.rejects(args(["docker", "logs", "--args-json", "@/does-not-exist"]), /Cannot read/);
});

test("gateway and plugin source URL flags remain unambiguous", async () => {
  const parsed = parse(["--url", "https://127.0.0.1:9876", "plugin", "install", "--url", "https://example.invalid/fixture.plg"], catalog);
  assert.equal(parsed.globals.url, "https://127.0.0.1:9876");
  assert.deepEqual(await argumentsFor(parsed), { url: "https://example.invalid/fixture.plg" });
});

test("usage and schema errors never invoke the client and never echo argument secrets", async t => {
  const { context } = await fixture(t);
  const key = randomKey();
  context.env.UNRAIDCLAW_KEY = key;
  context.env.UNRAIDCLAW_URL = "https://127.0.0.1:9876";
  const recording = recordingClient();
  const cli = capture(context, () => recording.client);
  for (const argv of [
    ["docker", "inspect"], ["docker", "inspect", "x", "--server", key],
    ["docker", "inspect", "x", `--${key}`], ["docker", "inspect", "x", "--force"],
    ["docker", "logs", "x", "--tail", key], ["docker", "create", "--image", "fixture", "--restart", key],
    ["ca", "install", "x", "--overrides", `{"PUID":1}`],
    ["ca", "install", "x", "--args-json", '{"dryRun":"true"}'],
    ["ca", "install", "x", "--args-json", JSON.stringify({ [key]: true })],
    ["docker", "inspect", "x", "--args-json", '{"server":"other"}'],
    ["docker", "remove", "x", "--force=true"], ["docker", "list", "extra"],
    ["docker", "inspect", "x", "--id", "second"], ["health", "--output", key],
  ]) {
    const result = await cli.run([...argv, "--yes"]);
    assert.equal(result.code, 2);
    assert.equal(recording.calls.length, 0);
    assert.ok(!(result.stdout + result.stderr).includes(key), "credential must not appear in diagnostics");
  }
});

test("mutations require confirmation, while reads never prompt, even on TTYs", async t => {
  const { context } = await fixture(t);
  context.env.UNRAIDCLAW_URL = "https://127.0.0.1:9876";
  const { client, calls } = recordingClient();
  const cli = capture(context, () => client);
  for (const command of ["system reboot", "docker remove", "ca install"]) {
    const argv = [...command.split(" "), ...(command === "system reboot" ? [] : ["fixture"])];
    const refused = await cli.run(argv);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /Would run/);
    assert.equal(calls.length, 0);
  }
  assert.equal((await cli.run(["docker", "remove", "fixture", "--yes"])).code, 0);
  assert.equal(calls.length, 1);
  cli.io.interactive = true;
  assert.equal((await cli.run(["docker", "remove", "fixture"])).confirmations, 1);
  assert.equal(calls.length, 2);
  cli.io.confirm = async () => false;
  assert.equal((await cli.run(["system", "reboot"])).code, 1);
  assert.equal(calls.length, 2);
  cli.io.confirm = async () => assert.fail("Reads must never prompt");
  assert.equal((await cli.run(["docker", "list"])).code, 0);
});

test("tools and built-in help expose their commands", async t => {
  const { context } = await fixture(t);
  const cli = capture(context);
  const listed = await cli.run(["tools", "--output", "json"]);
  assert.equal(listed.code, 0);
  assert.equal(JSON.parse(listed.stdout).length, 55);
  assert.match((await cli.run(["plugin", "--help"])).stdout, /plugin list/);
  assert.match((await cli.run(["config", "--help"])).stdout, /config set-key/);
  assert.match((await cli.run(["--version"])).stdout, /^unraidclaw 0\.1\.0/);
});

test("top-level help is a compact group overview for every spelling", async t => {
  const { context } = await fixture(t);
  const cli = capture(context);
  const expected = help(catalog) + "\n";
  for (const argv of [[], ["help"], ["--help"], ["-h"]]) {
    const result = await cli.run(argv);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, expected);
  }
  assert.match(expected, /^Usage: unraidclaw/);
  assert.match(expected, /docker +Docker containers: create, inspect, list, logs, \.\.\./);
  assert.match(expected, /unraidclaw <group> --help/);
  for (const group of new Set(catalog.map(command => command.name.split(" ")[0]))) {
    assert.ok(expected.split("\n").some(line => line.trimStart().startsWith(group + " ")));
  }
  for (const name of ["tools", "config", "trust"]) assert.ok(expected.includes(`  ${name} `));
  assert.match(expected, /--output table\|json/);
  assert.doesNotMatch(expected, /--image|--force|\(mutating\)|\(read-only\)/);
  assert.ok(expected.split("\n").length < 40);
});

test("group help shows summaries, classifications and aliases without schema flags", async t => {
  const { context } = await fixture(t);
  const cli = capture(context);
  for (const group of new Set(catalog.filter(command => command.name.includes(" ")).map(command => command.name.split(" ")[0]))) {
    const direct = await cli.run([group, "--help"]);
    const explicit = await cli.run(["help", group]);
    assert.equal(direct.code, 0);
    assert.equal(explicit.code, 0);
    assert.equal(direct.stdout, explicit.stdout);
    for (const command of catalog.filter(command => command.name.startsWith(group + " "))) {
      assert.ok(direct.stdout.includes(command.name));
      assert.ok(direct.stdout.includes(command.readOnly ? "(read-only)" : "(mutating)"));
      assert.ok(direct.stdout.includes(command.tool.description.split(/(?<=[.!?])\s/, 1)[0]));
    }
    assert.doesNotMatch(direct.stdout, /--image|--force|--dry-run|--server/);
  }
  assert.doesNotMatch((await cli.run(["docker", "--help"])).stdout, /Pass force=true/);
  assert.match((await cli.run(["plugin", "--help"])).stdout, /plugins list \(read-only\), aliases: plugin list/);
  assert.match((await cli.run(["health", "--help"])).stdout, /aliases: health/);
  assert.match((await cli.run(["log", "--help"])).stdout, /aliases: log syslog/);
});

test("command help retains full descriptions and every schema flag", async t => {
  const { context } = await fixture(t);
  const cli = capture(context);
  for (const command of catalog) {
    const result = await cli.run([...command.name.split(" "), "--help"]);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes(command.tool.description));
    for (const [name, schema] of Object.entries(command.schema.properties)) {
      assert.ok(result.stdout.includes(`--${kebab(name)}`));
      assert.ok(result.stdout.includes(schema.description ?? ""));
      if (schema.type === "boolean") assert.ok(result.stdout.includes(`--no-${kebab(name)}`));
    }
  }
});

test("supported dry runs skip confirmation on TTYs and in scripts using effective arguments", async t => {
  const { context } = await fixture(t);
  context.env.UNRAIDCLAW_URL = "https://127.0.0.1:9876";
  const { client, calls } = recordingClient();
  const cli = capture(context, () => client);
  cli.io.confirm = async () => assert.fail("Dry runs must not prompt");
  const supported = catalog.filter(command => Object.hasOwn(command.schema.properties, "dryRun"));
  assert.equal(supported.length, 7);
  for (const interactive of [false, true]) {
    cli.io.interactive = interactive;
    for (const command of supported) {
      const target = command.name === "plugin install" ? ["--url", "https://example.invalid/fixture.plg"] : ["fixture"];
      for (const flags of [["--dry-run"], ["--args-json", '{"dryRun":true}'], ["--args-json", '{"dryRun":false}', "--dry-run"]]) {
        const before = calls.length;
        const result = await cli.run([...command.name.split(" "), ...target, ...flags]);
        assert.equal(result.code, 0);
        assert.equal(result.stderr, "");
        assert.equal(calls.length, before + 1);
        assert.equal((calls.at(-1)!.payload as Record<string, unknown>).dryRun, true);
      }
    }
  }
  cli.io.interactive = false;
  for (const flags of [[], ["--no-dry-run"], ["--args-json", '{"dryRun":false}'], ["--args-json", '{"dryRun":true}', "--no-dry-run"]]) {
    const before = calls.length;
    const result = await cli.run(["ca", "install", "fixture", ...flags]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Confirmation required/);
    assert.equal(calls.length, before);
  }
  for (const argv of [
    ["ca", "install", "fixture", "--args-json", '{"dryRun":"true"}'],
    ["ca", "install", "fixture", "--args-json", '{"dryRun":1}'],
    ["docker", "remove", "fixture", "--args-json", '{"dryRun":true}'],
    ["docker", "remove", "fixture", "--dry-run"],
  ]) {
    const before = calls.length;
    assert.equal((await cli.run(argv)).code, 2);
    assert.equal(calls.length, before);
  }
});
