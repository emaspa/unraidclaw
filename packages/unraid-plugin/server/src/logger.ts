import { appendFileSync, statSync, renameSync, existsSync } from "node:fs";
import type { ServerConfig } from "./config.js";

export interface ActivityLogEntry {
  timestamp: string;
  method: string;
  path: string;
  resource: string;
  action: string;
  statusCode: number;
  durationMs: number;
  ip: string;
}

export class ActivityLogger {
  private logFile: string;
  private maxSize: number;

  constructor(config: ServerConfig) {
    this.logFile = config.logFile;
    this.maxSize = config.maxLogSize;
  }

  log(entry: ActivityLogEntry): void {
    try {
      this.rotateIfNeeded();
      appendFileSync(this.logFile, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // Logging should never crash the server
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.logFile)) return;
      const stats = statSync(this.logFile);
      if (stats.size >= this.maxSize) {
        const backup = this.logFile.replace(".jsonl", ".old.jsonl");
        if (existsSync(backup)) {
          // Remove old backup by overwriting
          renameSync(this.logFile, backup);
        } else {
          renameSync(this.logFile, backup);
        }
      }
    } catch {
      // Don't crash on rotation failure
    }
  }
}
