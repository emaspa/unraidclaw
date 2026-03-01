import type { ApiResponse } from "@unraidclaw/shared";

export class UnraidApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public errorCode: string
  ) {
    super(message);
    this.name = "UnraidApiError";
  }
}

export interface ClientConfig {
  serverUrl: string;
  apiKey: string;
  tlsSkipVerify?: boolean;
}

export class UnraidClient {
  private configResolver: () => ClientConfig;
  private tlsConfigured = false;

  constructor(configResolver: () => ClientConfig) {
    this.configResolver = configResolver;
  }

  private getConfig() {
    const cfg = this.configResolver();
    if (!cfg.serverUrl) {
      throw new UnraidApiError("UnraidClaw serverUrl not configured", 0, "CONFIG_ERROR");
    }
    // Disable TLS verification for self-signed certs (once)
    if (!this.tlsConfigured && cfg.tlsSkipVerify && cfg.serverUrl.startsWith("https")) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      this.tlsConfigured = true;
    }
    return {
      baseUrl: cfg.serverUrl.replace(/\/+$/, ""),
      apiKey: cfg.apiKey || "",
    };
  }

  async get<T>(path: string, query?: Record<string, string>): Promise<T> {
    const { baseUrl } = this.getConfig();
    let url = `${baseUrl}${path}`;
    if (query) {
      const params = new URLSearchParams(query);
      url += `?${params.toString()}`;
    }
    return this.request<T>("GET", url);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const { baseUrl } = this.getConfig();
    return this.request<T>("POST", `${baseUrl}${path}`, body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    const { baseUrl } = this.getConfig();
    return this.request<T>("PATCH", `${baseUrl}${path}`, body);
  }

  async delete<T>(path: string): Promise<T> {
    const { baseUrl } = this.getConfig();
    return this.request<T>("DELETE", `${baseUrl}${path}`);
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const { apiKey } = this.getConfig();
    const headers: Record<string, string> = {
      "x-api-key": apiKey,
    };

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      throw new UnraidApiError(
        `Connection failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        0,
        "CONNECTION_ERROR"
      );
    }

    const json = (await response.json()) as ApiResponse<T>;

    if (!json.ok) {
      throw new UnraidApiError(
        json.error.message,
        response.status,
        json.error.code
      );
    }

    return json.data;
  }
}
