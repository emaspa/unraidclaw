import type { ApiResponse } from "@unraidclaw/shared";

export interface ClientConfig {
  serverUrl: string;
  apiKey: string;
}

export class UnraidApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public errorCode: string
  ) {
    super(message);
    this.name = "UnraidApiError";
  }

  get isPermissionDenied(): boolean {
    return this.statusCode === 403;
  }

  get isUnauthorized(): boolean {
    return this.statusCode === 401;
  }

  get isNotFound(): boolean {
    return this.statusCode === 404;
  }

  get isServerError(): boolean {
    return this.statusCode >= 500;
  }
}

export class UnraidClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: ClientConfig) {
    this.baseUrl = config.serverUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
  }

  async get<T>(path: string, query?: Record<string, string>): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (query) {
      const params = new URLSearchParams(query);
      url += `?${params.toString()}`;
    }
    return this.request<T>("GET", url);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", `${this.baseUrl}${path}`, body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", `${this.baseUrl}${path}`, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", `${this.baseUrl}${path}`);
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      "Content-Type": "application/json",
    };

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
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
