import { attachResponseMetadata } from "@chase-sets/http/responses";

const DEFAULT_BASE_URL = "/api/marketplace";

export class OrderingApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(
      typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof (body as { error?: unknown }).error === "object" &&
        (body as { error?: unknown }).error !== null &&
        "message" in (body as { error: Record<string, unknown> }).error
        ? String((body as { error: { message?: unknown } }).error.message)
        : `API error ${status}`,
    );
  }
}

export interface OrderingApiClientOptions {
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
    throw new OrderingApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

export function createOrderingClientTransport({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: OrderingApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const headers = resolveHeaders(initialHeaders);

  return { baseUrl, configuredFetch, headers };
}

export type OrderingClientTransport = ReturnType<typeof createOrderingClientTransport>;
