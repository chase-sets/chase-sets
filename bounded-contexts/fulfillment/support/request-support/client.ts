import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata, readApiErrorMessage } from "@chase-sets/http/responses";
import type { buildFulfillmentApi } from "../../api";

type FulfillmentApiApp = ReturnType<typeof buildFulfillmentApi>;
const DEFAULT_BASE_URL = "/api/marketplace";

export class FulfillmentApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(
      typeof body === "object" && body !== null
        ? readApiErrorMessage(body, `API error ${status}`)
        : `API error ${status}`,
    );
  }
}

export interface FulfillmentApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

export async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new FulfillmentApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

export function createFulfillmentClientTransport({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: FulfillmentApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const client = honoClientResource(
    hc<FulfillmentApiApp>(baseUrl, {
      fetch: configuredFetch,
    }),
  );
  const headers = resolveHeaders(initialHeaders);
  const directUrl = (path: string) => `${baseUrl.replace(/\/$/, "")}${path}`;
  return { client, credentials, directUrl, configuredFetch, fetch, headers };
}

export type FulfillmentClientTransport = ReturnType<typeof createFulfillmentClientTransport>;
