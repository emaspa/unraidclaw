import { test } from "node:test";
import assert from "node:assert/strict";
import { format } from "../src/output.js";
import { capture, fixture, recordingClient } from "./helpers.js";
import { arrayStatus, dockerList, dockerLogs, syslog } from "./output-fixtures.js";

test("Docker list puts names before shortened IDs and renders scalar arrays without JSON", () => {
  assert.equal(format(dockerList), [
    "names     id            image            state    status      autoStart",
    "/Grafana  8cfbfc9d8945  grafana/grafana  RUNNING  Up 5 hours  true",
  ].join("\n"));
  assert.equal(format([{ id: "a", names: ["one", "two"], name: "short" }]),
    "name   names     id\nshort  one, two  a");
  assert.equal(format([{ values: [1, false, "three"] }]), "values\n1, false, three");
  assert.equal(format([{ values: [null, true, 2] }]), "values\nnull, true, 2");
});

test("table cells cap at 40 characters with ellipses and IDs shorten only above 24", () => {
  for (const length of [24, 25, 40, 41, 80]) {
    const text = "a".repeat(length);
    assert.equal(format([{ id: text }]), `id\n${length > 24 ? text.slice(0, 12) : text}`);
    assert.equal(format([{ value: text }]), `value\n${length > 40 ? text.slice(0, 37) + "..." : text}`);
  }
  // A shared server prefix must not make every row show the same id.
  for (const [id, shown] of [[`${"a".repeat(64)}:${"b".repeat(64)}`, "b".repeat(12)], [`${"c".repeat(64)}:short`, "short"]]) {
    assert.equal(format([{ id }]), `id\n${shown}`);
  }
  assert.equal(format([{ value: "one\ntwo\tthree\rfour" }]), "value\none two three four");
  assert.equal(format({ id: "a".repeat(80) }), `id: ${"a".repeat(80)}`);
});

test("Docker logs and syslog entries start below their keys without indentation or truncation", () => {
  assert.equal(format(dockerLogs), `id: Grafana\nlogs:\n${dockerLogs.logs}`);
  assert.equal(format(syslog), `entries:\n${syslog.entries.join("\n")}\ntotal: 2`);
  assert.equal(format("line 1\nline 2"), "line 1\nline 2");
});

test("array status recursively indents capacity and keeps disk objects as a sub-table", () => {
  assert.equal(format(arrayStatus), [
    "state: STARTED", "capacity:", "  kilobytes:",
    "    free: 2147483648", "    used: 1073741824", "    total: 3221225472",
    "  human:", "    free: 2.00 TiB", "    used: 1.00 TiB", "    total: 3.00 TiB",
    "disks:", "name   status   size        temp  device", "disk1  DISK_OK  3221225472  30    sdb",
  ].join("\n"));
  assert.equal(format({ status: "ok", entries: [] }), "status: ok\nentries:\n(empty)");
});

test("CLI renders response fixtures and JSON preserves every value without table changes", async t => {
  const { context } = await fixture(t);
  context.env.UNRAIDCLAW_URL = "https://127.0.0.1:9876";
  for (const [argv, data] of [
    [["docker", "list"], dockerList], [["docker", "logs", "Grafana"], dockerLogs],
    [["syslog"], syslog], [["array", "status"], arrayStatus],
  ] as const) {
    const original = JSON.stringify(data, null, 2);
    const cli = capture(context, () => ({ ...recordingClient().client, get: async <T>() => data as T }));
    const rendered = format(data);
    const table = await cli.run([...argv]);
    assert.equal(table.code, 0);
    assert.equal(table.stdout, rendered + (rendered.endsWith("\n") ? "" : "\n"));
    assert.equal(format(data, "json"), original);
    const json = await cli.run([...argv, "--output", "json"]);
    assert.equal(json.code, 0);
    assert.equal(json.stdout, original + "\n");
    assert.equal(JSON.stringify(data, null, 2), original);
  }
});
