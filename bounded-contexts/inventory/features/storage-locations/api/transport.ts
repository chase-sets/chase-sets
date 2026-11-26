import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata, readApiErrorMessage } from "@chase-sets/http/responses";
import type { buildInventoryApi } from "../../../api";

type InventoryApiApp = ReturnType<typeof buildInventoryApi>;

const DEFAULT_BASE_URL = "/api/inventory";

export class InventoryApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(readApiErrorMessage(body, `API error ${status}`));
  }
}

export interface InventoryApiClientOptions {
  mutationAttemptId?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
  requestTimeoutMs?: number;
  recoverTransportErrorsAsGatewayTimeout?: boolean;
}

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

export async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new InventoryApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

function timeoutFetchSignal(timeoutMs: number, upstreamSignal?: AbortSignal) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let removeUpstreamListener: (() => void) | null = null;
  const timeoutResponse = new Promise<Response>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(gatewayTimeoutResponse());
    }, timeoutMs);
  });

  if (upstreamSignal) {
    const abortFromUpstream = () => controller.abort();
    if (upstreamSignal.aborted) {
      controller.abort();
    } else {
      upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
      removeUpstreamListener = () => upstreamSignal.removeEventListener("abort", abortFromUpstream);
    }
  }

  return {
    signal: controller.signal,
    wait: (request: Promise<Response>) => Promise.race([request, timeoutResponse]),
    cleanup: () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      removeUpstreamListener?.();
    },
  };
}

function gatewayTimeoutResponse() {
  return new Response(null, {
    status: 504,
    statusText: "Gateway Timeout",
  });
}

export function createInventoryClientTransport({
  mutationAttemptId,
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
  requestTimeoutMs,
  recoverTransportErrorsAsGatewayTimeout = false,
}: InventoryApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = async (input, init = {}) => {
    const mutationHeaders = new Headers(init.headers);
    if (["POST", "PATCH"].includes(init.method?.toUpperCase() ?? "")) {
      mutationHeaders.set("Inventory-Mutation-Attempt", mutationAttemptId ?? globalThis.crypto.randomUUID());
    }
    const timeout =
      typeof requestTimeoutMs === "number" && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
        ? timeoutFetchSignal(requestTimeoutMs, init.signal ?? undefined)
        : null;

    try {
      const request = fetch(input, {
        ...init,
        headers: mutationHeaders,
        credentials: init.credentials ?? credentials,
        ...(timeout ? { signal: timeout.signal } : {}),
      });
      return await (timeout ? timeout.wait(request) : request);
    } catch (error) {
      if (recoverTransportErrorsAsGatewayTimeout) {
        return gatewayTimeoutResponse();
      }

      throw error;
    } finally {
      timeout?.cleanup();
    }
  };
  const client = honoClientResource(
    hc<InventoryApiApp>(baseUrl, {
      fetch: configuredFetch,
    }),
  );
  const headers = resolveHeaders(initialHeaders);

  return { client, headers };
}

export type InventoryClientTransport = ReturnType<typeof createInventoryClientTransport>;
