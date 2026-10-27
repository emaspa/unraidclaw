import type { ServerConfig } from "./config.js";

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string; path?: string[]; extensions?: { code?: unknown } }>;
}

export const UNRAID_API_KEY_MISSING_MESSAGE =
  "The Unraid API key is not configured, so UnraidClaw cannot call Unraid's GraphQL API. " +
  "Copy an Unraid API key with the ADMIN role from Settings > Management Access and paste it " +
  "into Unraid API Key in Settings > UnraidClaw.";

export class GraphQLClient {
  private url: string;
  private apiKey: string;

  constructor(config: ServerConfig) {
    this.url = config.graphqlUrl;
    this.apiKey = config.unraidApiKey;
  }

  async query<T = unknown>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    // Without x-api-key, unraid-api falls back to session authentication and
    // answers "Invalid CSRF token", which hides the real problem.
    if (!this.apiKey) {
      throw new GraphQLError(UNRAID_API_KEY_MISSING_MESSAGE, 503, "UNRAID_API_KEY_MISSING");
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
    };

    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new GraphQLError(
        `GraphQL request failed: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    const json = (await response.json()) as GraphQLResponse<T>;

    if (json.errors?.length) {
      if (json.errors.some((e) => e.extensions?.code === "UNAUTHENTICATED")) {
        throw new GraphQLError(
          `Unraid's GraphQL API rejected the Unraid API key (${json.errors.map((e) => e.message).join("; ")}). ` +
            "Check that the key in Settings > UnraidClaw still exists in Settings > Management Access and has the ADMIN role.",
          502,
          "UNRAID_API_KEY_REJECTED"
        );
      }
      throw new GraphQLError(
        json.errors.map((e) => e.message).join("; "),
        400
      );
    }

    if (!json.data) {
      throw new GraphQLError("No data returned from GraphQL", 502);
    }

    return json.data;
  }

  get hasApiKey(): boolean {
    return this.apiKey !== "";
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.query("{ __typename }");
      return true;
    } catch {
      return false;
    }
  }

  /** Checks reachability with a query that needs a valid key, since { __typename } works without one. */
  async check(): Promise<{ reachable: boolean; message?: string }> {
    try {
      await this.query("{ me { name } }");
      return { reachable: true };
    } catch (error) {
      if (error instanceof GraphQLError && error.code !== "GRAPHQL_ERROR") {
        return { reachable: error.code === "UNRAID_API_KEY_REJECTED", message: error.message };
      }
      return { reachable: await this.isReachable() };
    }
  }
}

export class GraphQLError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code = "GRAPHQL_ERROR"
  ) {
    super(message);
    this.name = "GraphQLError";
  }
}
