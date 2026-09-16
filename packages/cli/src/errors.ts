export class CliError extends Error {
  constructor(message: string, public readonly exitCode = 1) { super(message); }
}

export function usage(message: string): never { throw new CliError(message, 2); }

/** All output passes through this filter, including errors from the gateway. */
export class Secrets {
  private values = new Set<string>();
  add(value: unknown): void {
    if (typeof value !== "string" || !value) return;
    this.values.add(value);
    this.values.add(JSON.stringify(value).slice(1, -1));
    this.values.add(encodeURIComponent(value));
  }
  redact(text: string): string {
    for (const value of [...this.values].sort((a, b) => b.length - a.length)) {
      text = text.split(value).join("[redacted]");
    }
    return text;
  }
}
