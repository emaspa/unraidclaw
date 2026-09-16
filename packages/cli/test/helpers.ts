import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import type { ToolClient } from "unraidclaw/tools";
import type { Environment, Settings } from "../src/config.js";
import type { Terminal } from "../src/terminal.js";
import { run } from "../src/main.js";

export async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "unraidclaw-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const context: Environment = { root: dir, home: dir, env: {}, platform: process.platform };
  return { dir, context };
}
export const randomKey = (): string => randomBytes(32).toString("hex");

/** Regular files also work in sandboxes that disallow subprocess stdio sockets. */
export async function childOutput(dir: string, executable: string, args: string[], input = "") {
  const stdin = await open(join(dir, "stdin"), "w+", 0o600);
  const stdout = await open(join(dir, "stdout"), "w+", 0o600);
  const stderr = await open(join(dir, "stderr"), "w+", 0o600);
  try {
    await stdin.write(input, 0, "utf8");
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(executable, args, { cwd: dir, stdio: [stdin.fd, stdout.fd, stderr.fd] });
      const timer = setTimeout(() => { child.kill(); reject(new Error("Fixture process timed out")); }, 15_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); resolve(code); });
    });
    return { code, stdout: await readFile(join(dir, "stdout"), "utf8"), stderr: await readFile(join(dir, "stderr"), "utf8") };
  } finally { await Promise.all([stdin.close(), stdout.close(), stderr.close()]); }
}

export function capture(context: Environment, client?: (settings: Settings) => ToolClient) {
  let stdout = "", stderr = "", confirmations = 0;
  const io: Terminal = {
    out: text => { stdout += text; }, err: text => { stderr += text; },
    interactive: false,
    confirm: async () => { confirmations++; return true; },
    readKey: async () => randomKey(),
  };
  return {
    io,
    async run(args: string[]) {
      stdout = ""; stderr = ""; confirmations = 0;
      const code = await run(args, { context, terminal: io, client });
      return { code, stdout, stderr, confirmations };
    },
  };
}

export function recordingClient() {
  const calls: { method: string; path: string; payload?: unknown }[] = [];
  const send = async <T>(method: string, path: string, payload?: unknown): Promise<T> => {
    calls.push({ method, path, payload });
    return { method, path, payload } as T;
  };
  const client: ToolClient = {
    get: (path, query) => send("GET", path, query),
    post: (path, body) => send("POST", path, body),
    patch: (path, body) => send("PATCH", path, body),
    delete: path => send("DELETE", path),
  };
  return { calls, client };
}
