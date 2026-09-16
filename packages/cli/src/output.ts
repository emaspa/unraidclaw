function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function scalar(value: unknown): string {
  return value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
}
function cell(value: unknown, column: string): string {
  const text = (Array.isArray(value) && value.every(entry => entry === null || typeof entry !== "object")
    ? value.map(entry => entry === null ? "null" : scalar(entry)).join(", ") : scalar(value)).replace(/[\r\n\t]/g, " ");
  // Gateway ids can be prefixed with a server hash shared by every row, as in
  // "<server>:<container>", so shorten the last segment.
  if (column === "id" && text.length > 24) return text.slice(text.lastIndexOf(":") + 1).slice(0, 12);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}
export function format(value: unknown, output: "json" | "table" = "table"): string {
  if (output === "json") return JSON.stringify(value, null, 2);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (!value.length) return "(empty)";
    if (!value.every(object)) return value.map(entry => format(entry)).join("\n");
    const available = [...new Set(value.flatMap(row => Object.keys(row)))];
    const preferred = ["name", "names", "id", "command", "tool", "readOnly", "image", "state", "status", "size", "used", "free", "temp", "online", "description"];
    const columns = [...preferred.filter(name => available.includes(name)), ...available.filter(name => !preferred.includes(name))].slice(0, 8);
    const rows = [columns, ...value.map(row => columns.map(column => cell(row[column], column)))];
    const widths = columns.map((_, index) => Math.max(...rows.map(row => row[index].length)));
    return rows.map(row => row.map((text, index) => text.padEnd(widths[index])).join("  ").trimEnd()).join("\n");
  }
  if (object(value)) return Object.entries(value).map(([key, entry]) => {
    if (Array.isArray(entry) && entry.every(object)) return `${key}:\n${format(entry)}`;
    if (Array.isArray(entry) && entry.every(value => typeof value === "string")) return `${key}:\n${entry.join("\n")}`;
    if (typeof entry === "string" && /[\r\n]/.test(entry)) return `${key}:\n${entry}`;
    if (object(entry)) return `${key}:\n${format(entry).split("\n").map(line => `  ${line}`).join("\n")}`;
    return `${key}: ${typeof entry === "string" ? entry : JSON.stringify(entry)}`;
  }).join("\n");
  return String(value);
}
