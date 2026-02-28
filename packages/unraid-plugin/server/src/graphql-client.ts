import type { ServerConfig } from "./config.js";

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string; path?: string[] }>;
}

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
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

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

  async isReachable(): Promise<boolean> {
    try {
      await this.query("{ __typename }");
      return true;
    } catch {
      return false;
    }
  }
}

export class GraphQLError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
    this.name = "GraphQLError";
  }
}
