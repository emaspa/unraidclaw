import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, stat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { GraphQLClient } from "../src/graphql-client.js";
import type { CommandRunner } from "../src/docker-common.js";

const root = await mkdtemp(join(tmpdir(), "legacy-mutations-"));
process.env.FLASH_BASE = root;
const { loadPermissions } = await import("../src/config.js");
const { registerArrayRoutes } = await import("../src/routes/array.js");
const { registerDockerRoutes } = await import("../src/routes/docker.js");
const { registerVMRoutes } = await import("../src/routes/vms.js");
const { registerShareRoutes } = await import("../src/routes/shares.js");
const { registerNotificationRoutes } = await import("../src/routes/notifications.js");
await writeFile(join(root, "permissions.json"), JSON.stringify(Object.fromEntries(
  ["array", "docker", "vms", "share", "notification"].flatMap((r) => ["read", "create", "update", "delete"].map((a) => [`${r}:${a}`, true])))));
loadPermissions();
after(() => rm(root, { recursive: true, force: true }));
function recorder(output: (args: string[]) => string = () => "") {
  const calls: { file: string; args: string[]; timeout: number }[] = [];
  const run: CommandRunner = async (file, args, options) => {
    assert.ok(options.timeout > 0 && options.timeout <= 120000);
    calls.push({ file, args, timeout: options.timeout });
    return { stdout: output(args), stderr: "" };
  };
  return { calls, run };
}
function graphql(output: () => unknown = () => { throw new Error("Unexpected GraphQL call"); }) {
  return { query: async () => output() } as GraphQLClient;
}

test("parity rejects unsafe bodies and verifies every driver transition", async (t) => {
  const app = Fastify(); t.after(() => app.close()); let state = "";
  const runner = recorder(() => state); registerArrayRoutes(app, graphql(), runner.run, 1);
  for (const payload of [{ correct: "false" }, { correct: null }, { correct: 1 }, { correct: [] }, { dryRun: true }, []]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/array/parity/start", payload })).statusCode, 400);
  }
  assert.equal(runner.calls.length, 0);
  for (const [action, output, argv] of [
    ["start", "mdResync=1\nmdResyncPos=0", ["check", "NOCORRECT"]],
    ["pause", "mdResync=0\nmdResyncPos=100", ["nocheck", "PAUSE"]],
    ["resume", "mdResync=1\nmdResyncPos=100", ["check", "RESUME"]],
    ["cancel", "mdResync=0\nmdResyncPos=0", ["nocheck", "CANCEL"]],
  ] as const) {
    state = output;
    assert.equal((await app.inject({ method: "POST", url: `/api/array/parity/${action}` })).json().data.verified, true);
    assert.deepEqual(runner.calls.at(-2)?.args, argv);
    assert.deepEqual(runner.calls.at(-1)?.args, ["status"]);
    state = action === "cancel" ? "mdResync=1" : "mdResync=0\nmdResyncPos=0";
    assert.equal((await app.inject({ method: "POST", url: `/api/array/parity/${action}` })).json().error.code, "VERIFICATION_FAILED");
  }
  state = "mdResync=1";
  assert.equal((await app.inject({ method: "POST", url: "/api/array/parity/start", payload: { correct: true } })).json().data.verified, true);
  assert.deepEqual(runner.calls.at(-2)?.args, ["check", "CORRECT"]);
});
test("array start and stop verify returned state", async (t) => {
  const app = Fastify(); t.after(() => app.close()); let state = "";
  registerArrayRoutes(app, graphql(() => ({ array: { setState: { state } } })), recorder().run);
  for (const action of ["start", "stop"]) {
    state = action === "start" ? "STARTED" : "STOPPED";
    assert.equal((await app.inject({ method: "POST", url: `/api/array/${action}` })).json().data.verified, true);
    state = "STARTING";
    const lagging = await app.inject({ method: "POST", url: `/api/array/${action}` });
    assert.equal(lagging.statusCode, 200);
    assert.equal(lagging.json().data.verified, false);
  }
});
test("shares reject cfg injection and coercion and atomically preserve mode", async (t) => {
  const dir = await mkdtemp(join(root, "shares-")); const file = join(dir, "media.cfg");
  const original = 'shareComment="old"\nshareFloor="0"\n';
  await writeFile(file, original, { mode: 0o640 });
  const app = Fastify(); t.after(() => app.close());
  registerShareRoutes(app, graphql(() => ({ shares: [{ name: "media" }] })), dir);
  for (const payload of [
    ...['"\nshareFloor="9', "a\nb", "a\rb", "a\tb", "a\\b", "$HOME", "`id`", "\x7f", "\x85", 4].map((comment) => ({ comment })),
    { extra: true }, { allocator: false }, { allocator: "" },
    ...[null, true, [], {}, "", "1.5", "1e2", " 2", -1, 1.2, Number.MAX_SAFE_INTEGER + 1].flatMap((value) => [{ floor: value }, { splitLevel: value }]),
  ]) {
    assert.equal((await app.inject({ method: "PATCH", url: "/api/shares/media", payload })).statusCode, 400, JSON.stringify(payload));
    assert.equal(await readFile(file, "utf8"), original);
  }
  const before = await stat(file);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/shares/media", payload: { comment: "safe", floor: "42", splitLevel: 2, allocator: "fill" } })).json().data.verified, true);
  const current = await stat(file); assert.equal(current.mode & 0o777, 0o640); assert.notEqual(before.ino, current.ino);
  assert.match(await readFile(file, "utf8"), /shareFloor="42"/); assert.deepEqual(await readdir(dir), ["media.cfg"]);
});
test("docker rejects option IDs, invalid logs and force before commands", async (t) => {
  const app = Fastify(); t.after(() => app.close()); const runner = recorder();
  registerDockerRoutes(app, graphql(), { run: runner.run });
  const cases = [
    ["GET", "/api/docker/containers/-x"], ["GET", "/api/docker/containers/-x/logs"], ["DELETE", "/api/docker/containers/-x"],
    ...["start", "stop", "restart", "pause", "unpause"].map((a) => ["POST", `/api/docker/containers/-x/${a}`]),
    ...["tail=0", "tail=-1", "tail=1.5", "tail=10001", "tail=1x", "since=-x", `since=${"x".repeat(129)}`].map((q) => ["GET", `/api/docker/containers/app/logs?${q}`]),
    ["DELETE", "/api/docker/containers/app?force=1"],
  ];
  for (const [method, url] of cases) assert.equal((await app.inject({ method: method as "GET", url })).statusCode, 400, url);
  assert.equal(runner.calls.length, 0);
});
test("docker actions and removal verify state with bounded argv commands", async (t) => {
  const app = Fastify(); t.after(() => app.close()); let state = "running"; let listing = "";
  const runner = recorder((args) => args[0] === "inspect" ? `abcdef\t/app\t${state}` : args[0] === "ps" ? listing : "");
  registerDockerRoutes(app, graphql(), { run: runner.run });
  for (const action of ["start", "stop", "restart", "pause", "unpause"]) {
    state = action === "stop" ? "exited" : action === "pause" ? "paused" : "running";
    const res = await app.inject({ method: "POST", url: `/api/docker/containers/app/${action}` });
    assert.equal(res.json().data.verified, true); assert.equal(res.json().data.id, "abcdef");
    assert.deepEqual(runner.calls.at(-2)?.args, [action, "--", "app"]);
    state = "dead";
    assert.equal((await app.inject({ method: "POST", url: `/api/docker/containers/app/${action}` })).json().error.code, "VERIFICATION_FAILED");
  }
  for (const force of ["true", "false"]) {
    listing = "";
    assert.equal((await app.inject({ method: "DELETE", url: `/api/docker/containers/app?force=${force}` })).json().data.verified, true);
    listing = "abcdef\tapp";
    assert.equal((await app.inject({ method: "DELETE", url: `/api/docker/containers/app?force=${force}` })).json().error.code, "VERIFICATION_FAILED");
  }
  // A name is matched exactly, never as a prefix of another container's id.
  listing = "abc0123456789\tother";
  assert.equal((await app.inject({ method: "DELETE", url: "/api/docker/containers/abc" })).json().data.verified, true);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/docker/containers/abc0123456789" })).json().error.code, "VERIFICATION_FAILED");
  for (const tail of ["1", "10000", "all"]) assert.equal((await app.inject({ url: `/api/docker/containers/app/logs?tail=${tail}` })).statusCode, 200);
});
test("docker create rejects wrong types, labels and traversal before mkdir", async (t) => {
  const app = Fastify(); t.after(() => app.close()); const runner = recorder();
  registerDockerRoutes(app, graphql(), { run: runner.run, mkdir: async () => { throw new Error("Unexpected mkdir"); } });
  for (const payload of [[], { image: "alpine", extra: 1 }, { image: 4 },
    ...["ports", "volumes", "env"].flatMap((key) => [{ image: "alpine", [key]: "x" }, { image: "alpine", [key]: [3] }]),
    ...["name", "restart", "network", "icon", "webui"].map((key) => ({ image: "alpine", [key]: 1 })),
    ...[[], null, { x: 2 }, { "x=y": "z" }, { "-x": "y" }].map((labels) => ({ image: "alpine", labels })),
    { image: "alpine", volumes: ["/mnt/../../tmp/escape:/data"] },
  ]) assert.equal((await app.inject({ method: "POST", url: "/api/docker/containers", payload })).statusCode, 400, JSON.stringify(payload));
  assert.equal(runner.calls.length, 0);
});
const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
test("VM actions return identity and verify state with bounded asynchronous polling", async (t) => {
  const app = Fastify(); t.after(() => app.close()); let states = ["running"];
  const runner = recorder((args) => args[0] === "domuuid" ? uuid : args[0] === "domname" ? "my-vm" : args[0] === "domstate" ? (states.length > 1 ? states.shift()! : states[0]) : "");
  registerVMRoutes(app, graphql(), { run: runner.run, pollAttempts: 3, pollIntervalMs: 0 });
  for (const action of ["start", "stop", "force-stop", "pause", "resume", "reboot", "reset"]) {
    assert.equal((await app.inject({ method: "POST", url: `/api/vms/-x/${action}` })).statusCode, 400);
    states = [action === "stop" || action === "force-stop" ? "shut off" : action === "pause" ? "paused" : "running"];
    const res = await app.inject({ method: "POST", url: `/api/vms/my-vm/${action}` });
    assert.deepEqual(res.json().data, { id: uuid, uuid, name: "my-vm", state: states[0], verified: true });
    states = ["blocked"];
    const failed = await app.inject({ method: "POST", url: `/api/vms/my-vm/${action}` });
    assert.equal(failed.json().data.verified, false);
    assert.equal(failed.statusCode, action === "stop" || action === "reboot" ? 200 : 500);
  }
  states = ["running", "in shutdown", "shut off"];
  assert.equal((await app.inject({ method: "POST", url: "/api/vms/my-vm/stop" })).json().data.verified, true);
});
test("VM removal preserves destroy failures and verifies undefined domains", async (t) => {
  const app = Fastify(); t.after(() => app.close()); let state = "running"; let failDestroy = true; let listing = uuid;
  const runner = recorder((args) => {
    if (args[0] === "domuuid") return uuid;
    if (args[0] === "domname") return "my-vm";
    if (args[0] === "domstate") return state;
    if (args[0] === "destroy") { if (failDestroy) throw new Error("destroy failed"); state = "shut off"; }
    return args[0] === "list" ? listing : "";
  });
  registerVMRoutes(app, graphql(), { run: runner.run });
  assert.equal((await app.inject({ method: "DELETE", url: "/api/vms/-x" })).statusCode, 400);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/vms/my-vm" })).json().error.code, "VM_REMOVE_FAILED");
  assert.ok(!runner.calls.some((c) => c.args[0] === "undefine"));
  failDestroy = false;
  assert.equal((await app.inject({ method: "DELETE", url: "/api/vms/my-vm" })).json().error.code, "VERIFICATION_FAILED");
  listing = "";
  assert.equal((await app.inject({ method: "DELETE", url: "/api/vms/my-vm" })).json().data.verified, true);
});
test("notifications validate bodies and list filters before external calls", async (t) => {
  const app = Fastify(); t.after(() => app.close()); const runner = recorder(); let queries = 0;
  registerNotificationRoutes(app, graphql(() => { queries++; return { notifications: { list: [] } }; }), { run: runner.run, root });
  for (const query of ["type=bad", "limit=-1", "limit=1x", "limit=1001", "offset=1.5", "offset=1000001"]) assert.equal((await app.inject({ url: `/api/notifications?${query}` })).statusCode, 400);
  const body = { title: "Test", subject: "Subject", description: "Description" };
  for (const payload of [[], { ...body, extra: 1 }, { ...body, importance: "critical" }, { ...body, importance: false },
    ...["title", "subject", "description"].flatMap((key) => [1, null, "", "x".repeat(4097)].map((value) => ({ ...body, [key]: value }))),
  ]) assert.equal((await app.inject({ method: "POST", url: "/api/notifications", payload })).statusCode, 400);
  assert.equal(queries, 0); assert.equal(runner.calls.length, 0);
  for (const importance of ["normal", "warning", "alert"]) assert.equal((await app.inject({ method: "POST", url: "/api/notifications", payload: { ...body, importance } })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/notifications?type=ARCHIVE&limit=0&offset=0" })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/notifications?type=unread" })).statusCode, 200);
});
test("notifications verify archive and delete in injected directories", async (t) => {
  const dir = await mkdtemp(join(root, "notifications-")); await mkdir(join(dir, "unread"));
  await writeFile(join(dir, "unread", "sample"), "notification");
  const app = Fastify(); t.after(() => app.close()); registerNotificationRoutes(app, graphql(), { run: recorder().run, root: dir });
  assert.equal((await app.inject({ method: "POST", url: "/api/notifications/sample/archive" })).json().data.verified, true);
  assert.deepEqual(await readdir(join(dir, "unread")), []);
  assert.equal(await readFile(join(dir, "archive", "sample"), "utf8"), "notification");
  assert.equal((await app.inject({ method: "DELETE", url: "/api/notifications/sample" })).json().data.verified, true);
  assert.deepEqual(await readdir(join(dir, "archive")), []);
});
test("docker create verifies running state and writes only the injected template path", async (t) => {
  const dir = await mkdtemp(join(root, "templates-")); const app = Fastify(); t.after(() => app.close());
  let state = "running"; const directories: string[] = [];
  const runner = recorder((args) => args[0] === "run" ? "abcdef" : JSON.stringify([{ Id: "abcdef", Name: "/app", Config: { Image: "alpine" }, State: { Status: state } }]));
  registerDockerRoutes(app, graphql(), { run: runner.run, templatesDir: dir, mkdir: (async (path: string) => { directories.push(path); }) as typeof mkdir });
  const payload = { image: "alpine", name: "app", volumes: ["/mnt/user/app:/data"], labels: { "sample.label": "value" } };
  assert.equal((await app.inject({ method: "POST", url: "/api/docker/containers", payload })).json().data.verified, true);
  assert.deepEqual(directories, ["/mnt/user/app"]);
  assert.match(await readFile(join(dir, "my-app.xml"), "utf8"), /<Name>app<\/Name>/);
  assert.deepEqual(runner.calls.at(-1)?.args, ["inspect", "--", "abcdef"]);
  state = "exited";
  await rm(join(dir, "my-app.xml"));
  const exited = await app.inject({ method: "POST", url: "/api/docker/containers", payload });
  assert.equal(exited.json().error.code, "VERIFICATION_FAILED");
  assert.equal(exited.json().data.state, "exited");
  // The container exists, so its template is still saved for the Docker tab.
  assert.match(await readFile(join(dir, "my-app.xml"), "utf8"), /<Name>app<\/Name>/);
});
test("docker create reports docker's stderr without the command line or environment values", async (t) => {
  const dir = await mkdtemp(join(root, "templates-")); const app = Fastify(); t.after(() => app.close());
  const secret = "fixture-secret-value";
  const run: CommandRunner = async (_file, args) => {
    throw Object.assign(new Error(`Command failed: docker ${args.join(" ")}`), { stderr: "docker: Error response from daemon: port is already allocated.\n" });
  };
  registerDockerRoutes(app, graphql(), { run, templatesDir: dir, mkdir: (async () => {}) as typeof mkdir });
  const res = await app.inject({ method: "POST", url: "/api/docker/containers", payload: { image: "alpine", env: [`PASSWORD=${secret}`] } });
  assert.equal(res.json().error.code, "DOCKER_CREATE_FAILED");
  assert.match(res.json().error.message, /port is already allocated/);
  assert(!res.body.includes(secret));
});
test("command failures never become verified mutation successes", async (t) => {
  const app = Fastify(); t.after(() => app.close());
  const runner = recorder(() => { throw new Error("Command timed out"); });
  registerArrayRoutes(app, graphql(), runner.run, 1);
  registerDockerRoutes(app, graphql(), { run: runner.run });
  registerVMRoutes(app, graphql(), { run: runner.run });
  registerNotificationRoutes(app, graphql(), { run: runner.run, root });
  for (const url of ["/api/array/parity/start", "/api/docker/containers/app/start", "/api/vms/app/start"]) {
    const res = await app.inject({ method: "POST", url }); assert.equal(res.json().ok, false);
  }
  for (const url of ["/api/docker/containers/app", "/api/vms/app"]) assert.equal((await app.inject({ method: "DELETE", url })).json().ok, false);
  assert.equal((await app.inject({ method: "POST", url: "/api/notifications", payload: { title: "test", subject: "test", description: "test" } })).json().ok, false);
});
test("parity refuses missing or malformed driver status", async (t) => {
  const app = Fastify(); t.after(() => app.close()); let output = "";
  registerArrayRoutes(app, graphql(), recorder(() => output).run, 1);
  for (const status of ["", "mdResync=invalid", "mdResync=0\nmdResyncPos=invalid"]) {
    output = status;
    const res = await app.inject({ method: "POST", url: "/api/array/parity/cancel" });
    assert.equal(res.json().ok, false); assert.equal(res.json().error.code, "MDCMD_ERROR");
  }
});
test("VM server-prefixed IDs remain usable without passing the prefix to virsh", async (t) => {
  const app = Fastify(); t.after(() => app.close());
  const runner = recorder((args) => args[0] === "domuuid" ? uuid : args[0] === "domname" ? "my-vm" : "running");
  registerVMRoutes(app, graphql(() => ({ vms: { domains: [{ id: `server:${uuid}`, name: "my-vm", state: "running" }] } })), { run: runner.run });
  assert.equal((await app.inject({ url: `/api/vms/server:${uuid}` })).json().data.uuid, uuid);
  assert.equal((await app.inject({ method: "POST", url: `/api/vms/server:${uuid}/start` })).json().data.verified, true);
  assert.deepEqual(runner.calls[0].args, ["domuuid", uuid]);
  assert.equal((await app.inject({ method: "POST", url: "/api/vms/server:-x/start" })).statusCode, 400);
  const spaced = await app.inject({ method: "POST", url: `/api/vms/${encodeURIComponent("Windows 11")}/start` });
  assert.equal(spaced.statusCode, 200);
  assert.deepEqual(runner.calls.at(-4)!.args, ["domuuid", "Windows 11"]);
});
