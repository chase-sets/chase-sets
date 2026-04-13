import { hc } from "hono/client";
import type { buildPaymentsApi } from "./api";
import type { PaymentsPaymentDetail } from "./features/payments/api/contracts";

type PaymentsApiApp = ReturnType<typeof buildPaymentsApi>;
const DEFAULT_BASE_URL = "/api/marketplace";

export class PaymentsApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(
      typeof body === "object" && body !== null && "error" in body
        ? String((body as Record<string, unknown>).error)
        : `API error ${status}`,
    );
  }
}

export interface PaymentsApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new PaymentsApiError(response.status, errorBody);
  }

  return response.json() as Promise<T>;
}

export function createPaymentsApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: PaymentsApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const client = hc<PaymentsApiApp>(baseUrl, { fetch: configuredFetch }) as any;
  const headers = resolveHeaders(initialHeaders);

  return {
    async createBuyerPayment(body: Record<string, unknown>): Promise<PaymentsPaymentDetail> {
      return parseJsonResponse(
        await client.buyer.payments.$post({
          json: body,
          header: headers,
        }),
      );
    },
    async getBuyerPayment(paymentId: string): Promise<PaymentsPaymentDetail> {
      return parseJsonResponse(
        await client.buyer.payments[":id"].$get({
          param: { id: paymentId },
          header: headers,
        }),
      );
    },
  };
}

export type { PaymentsPaymentDetail } from "./features/payments/api/contracts";
export const paymentsApi = createPaymentsApiClient();
