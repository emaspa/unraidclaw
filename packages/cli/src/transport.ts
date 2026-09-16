import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import type { ToolClient } from "unraidclaw/tools";
import { gatewayUrl, type Settings } from "./config.js";
import { CliError, usage } from "./errors.js";

/** Use known codes, never the error message, which could contain request secrets. */
export function connectionError(error: unknown, url: URL): CliError {
  const cause = error as NodeJS.ErrnoException | undefined;
  const code = typeof cause?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(cause.code) ? cause.code : undefined;
  const host = url.hostname;
  switch (code) {
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
    case "CERT_UNTRUSTED":
      return new CliError("The gateway certificate is not trusted. Run unraidclaw trust, use --ca-cert <path>, or check that the configured caCert matches the server. A regenerated certificate needs trusting again.");
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return new CliError(`The host or IP ${host} in the URL is not listed in the gateway certificate. Use an address the certificate lists or regenerate the certificate in Settings > UnraidClaw > Settings.`);
    case "CERT_HAS_EXPIRED":
      return new CliError("The gateway certificate has expired. Check the system clock and regenerate the certificate in Settings, then trust it again.");
    case "CERT_NOT_YET_VALID":
      return new CliError("The gateway certificate is not yet valid. Check the system clocks on this machine and the gateway.");
    case "ECONNREFUSED":
      return new CliError(`Nothing is listening at ${url.origin}. Check the port and that the UnraidClaw service is running.`);
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return new CliError(`Cannot resolve the host ${host}. Check the host name and DNS settings.`);
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "ETIMEDOUT":
      return new CliError(`The host ${host} is unreachable or the connection timed out. Check connectivity and firewall settings.`);
    case "ECONNRESET":
    case "EPROTO":
      return new CliError(`Connection reset or TLS protocol error at ${url.origin}. Check http vs https in the gateway URL and that the port uses that protocol.`);
  }
  if (typeof cause?.message === "string" && /wrong version number/i.test(cause.message)) {
    return new CliError(`TLS protocol mismatch at ${url.origin}. Check http vs https in the gateway URL and that the port uses that protocol.`);
  }
  return new CliError(`Connection failed${code ? ` (${code})` : ""}. Check the gateway URL, connectivity and TLS certificate trust.`);
}

const timeoutError = () => Object.assign(new Error("Connection timed out"), { code: "ETIMEDOUT" });

export class HttpClient implements ToolClient {
  failure?: CliError;
  constructor(private readonly settings: Settings) {}

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      const base = gatewayUrl(this.settings.url);
      if (!path.startsWith("/api/")) throw new CliError("Invalid API path.");
      const url = new URL(path, base);
      if (url.origin !== base.origin || !url.pathname.startsWith("/api/")) throw new CliError("Invalid API path.");
      const key = this.settings.key;
      if (path !== "/api/health" && !key) usage("Set the API key with config set-key or UNRAIDCLAW_KEY.");
      if (key && /[\r\n\0]/.test(key)) usage("The API key must be a single line.");
      let ca: Buffer | undefined;
      if (base.protocol === "https:" && this.settings.caCert && !this.settings.insecure) {
        try { ca = await readFile(this.settings.caCert); } catch { throw new CliError("Cannot read CA certificate."); }
      }
      const payload = body === undefined ? undefined : JSON.stringify(body);
      return await new Promise<T>((resolve, reject) => {
        const client = url.protocol === "https:" ? https : http;
        const request = client.request(url, {
          method, ca, rejectUnauthorized: !this.settings.insecure, agent: false,
          headers: {
            ...(key ? { "x-api-key": key } : {}),
            ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
          },
        }, response => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 32 * 1024 * 1024) { request.destroy(); reject(new CliError("Gateway response exceeds 32 MiB.")); }
            else chunks.push(chunk);
          });
          response.on("error", error => reject(connectionError(error, base)));
          response.on("end", () => {
            const status = response.statusCode ?? 500;
            const code = status === 401 ? 3 : status === 403 ? 4 : 1;
            let envelope;
            try { envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
            catch { reject(new CliError(`HTTP ${status}: Invalid gateway JSON response.`, code)); return; }
            if (status >= 400 || envelope?.ok !== true) {
              const error = envelope?.error;
              const message = error && typeof error.code === "string" && typeof error.message === "string"
                ? `${error.code}: ${error.message}` : `HTTP ${status}: Gateway request failed.`;
              reject(new CliError(message, code));
            } else if (status < 200 || status >= 300 || !Object.hasOwn(envelope, "data")) {
              reject(new CliError(`HTTP ${status}: Unexpected gateway response. Redirects are not followed.`));
            } else resolve(envelope.data as T);
          });
        });
        const timer = setTimeout(() => request.destroy(timeoutError()), 30_000);
        request.on("close", () => clearTimeout(timer));
        request.on("error", error => reject(connectionError(error, base)));
        request.end(payload);
      });
    } catch (error) {
      this.failure = error instanceof CliError ? error : new CliError("Request failed.");
      throw this.failure;
    }
  }
  get<T>(path: string, query?: Record<string, string>): Promise<T> { return this.send("GET", query ? `${path}?${new URLSearchParams(query)}` : path); }
  post<T>(path: string, body?: unknown): Promise<T> { return this.send("POST", path, body); }
  patch<T>(path: string, body?: unknown): Promise<T> { return this.send("PATCH", path, body); }
  delete<T>(path: string): Promise<T> { return this.send("DELETE", path); }
}

/** TLS handshake only, with no API key or HTTP request. */
export async function peerCertificate(url: URL): Promise<X509Certificate> {
  if (url.protocol !== "https:") usage("trust requires an https:// gateway URL.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: Number(url.port || 443), rejectUnauthorized: false,
      ...(isIP(host) ? {} : { servername: host }) });
    const timer = setTimeout(() => socket.destroy(timeoutError()), 30_000);
    socket.on("close", () => clearTimeout(timer));
    socket.on("error", error => reject(connectionError(error, url)));
    socket.once("secureConnect", () => {
      try {
        const cert = socket.getPeerCertificate();
        resolve(new X509Certificate(cert.raw));
      } catch { reject(new CliError("Gateway did not supply a readable certificate.")); }
      finally { socket.destroy(); }
    });
  });
}
