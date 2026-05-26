import { BASE_URL, API_VERSION, REQUEST_TIMEOUT_MS } from "./constants.js";
import {
  WhoopApiError,
  WhoopAuthExpiredError,
  WhoopServerError,
} from "./errors.js";

export interface WhoopClientConfig {
  /** Async function returning a fresh bearer token. Called before each request. */
  getToken: () => Promise<string>;
}

type QueryValue = string | number | boolean | undefined | null;

export class WhoopClient {
  constructor(private readonly config: WhoopClientConfig) {}

  async get<T = unknown>(
    path: string,
    query: Record<string, QueryValue> = {},
  ): Promise<T> {
    return this.request<T>("GET", path, query, undefined);
  }

  async post<T = unknown>(
    path: string,
    body: unknown,
    query: Record<string, QueryValue> = {},
  ): Promise<T> {
    return this.request<T>("POST", path, query, body);
  }

  async put<T = unknown>(
    path: string,
    body: unknown,
    query: Record<string, QueryValue> = {},
  ): Promise<T> {
    return this.request<T>("PUT", path, query, body);
  }

  async delete<T = unknown>(
    path: string,
    query: Record<string, QueryValue> = {},
  ): Promise<T> {
    return this.request<T>("DELETE", path, query, undefined);
  }

  private async request<T>(
    method: string,
    path: string,
    query: Record<string, QueryValue>,
    body: unknown,
  ): Promise<T> {
    const url = new URL(BASE_URL + path);
    url.searchParams.set("apiVersion", API_VERSION);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }

    const token = await this.config.getToken();
    const headers: Record<string, string> = {
      authorization: `bearer ${token}`,
      accept: "application/json",
    };
    let bodyString: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      bodyString = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const init: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };
    if (bodyString !== undefined) init.body = bodyString;

    let response: Response;
    try {
      response = await fetch(url.toString(), init);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401) {
      throw new WhoopAuthExpiredError();
    }
    if (response.status >= 500) {
      throw new WhoopServerError(response.status, path);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let description: string | undefined;
      try {
        const parsed = JSON.parse(text) as { error_description?: string; error?: string };
        description = parsed.error_description ?? parsed.error;
      } catch {
        // body not JSON
      }
      throw new WhoopApiError(response.status, path, text, description);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}
