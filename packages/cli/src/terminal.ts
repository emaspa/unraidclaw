import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { CliError, usage } from "./errors.js";

export interface Terminal {
  out(text: string): void;
  err(text: string): void;
  interactive: boolean;
  confirm(prompt: string): Promise<boolean>;
  readKey(): Promise<string>;
}

export function terminal(): Terminal {
  return {
    out: text => { process.stdout.write(text); },
    err: text => { process.stderr.write(text); },
    interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
    confirm: async prompt => (await question(`${prompt} [y/N] `, false)).trim().toLowerCase() === "y",
    async readKey() {
      if (process.stdin.isTTY) return question("API key (hidden): ", true);
      let data = "";
      for await (const chunk of process.stdin) {
        data += chunk.toString();
        if (Buffer.byteLength(data) > 65536) usage("API key input is too large.");
      }
      return data.trim();
    },
  };
}

function question(prompt: string, hidden: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    // readline manages raw mode and restores it on close. A muted output keeps
    // pasted keys, editing keystrokes and redraws out of terminal output.
    const output = hidden ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stderr;
    const rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
    let answered = false;
    process.stderr.write(prompt);
    rl.on("SIGINT", () => rl.close());
    rl.once("close", () => { if (!answered) reject(new CliError("Input cancelled.")); });
    rl.question("", answer => {
      answered = true;
      if (hidden) process.stderr.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}
