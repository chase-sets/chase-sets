import { hc } from "hono/client";
import type { buildPaymentsApi } from "./api";
import type {
  PaymentsCheckoutStatus,
  PaymentsPaymentDetail,
  PaymentsProviderEvent,
} from "./features/payments/api/contracts";

type PaymentsApiApp = ReturnType<typeof buildPaymentsApi>;
const DEFAULT_BASE_URL = "/api/marketplace";

export type CreateAccountPaymentRequest = Readonly<{
  orderIds: readonly string[];
  currencyCode?: string;
  sourceContext?: string | null;
  sourceReferenceId?: string | null;
  requestedBalanceCreditAmount?: string | null;
}>;

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
    async createAccountPayment(
      body: CreateAccountPaymentRequest,
    ): Promise<PaymentsPaymentDetail> {
      return parseJsonResponse(
        await client.account.payments.$post({
          json: body,
          header: headers,
        }),
      );
    },
    async getAccountPayment(paymentId: string): Promise<PaymentsPaymentDetail> {
      return parseJsonResponse(
        await client.account.payments[":id"].$get({
          param: { id: paymentId },
          header: headers,
        }),
      );
    },
    async getCheckoutStatus(params: Readonly<{
      orderIds: readonly string[];
      currencyCode?: string;
      requestedBalanceCreditAmount?: string | null;
    }>): Promise<PaymentsCheckoutStatus> {
      const query = {
        orderIds: params.orderIds.join(","),
        currencyCode: params.currencyCode ?? "usd",
        requestedBalanceCreditAmount: params.requestedBalanceCreditAmount ?? undefined,
      };
      return parseJsonResponse(
        await client.account.checkout.status.$get({
          query,
          header: headers,
        }),
      );
    },
    async getProviderEvent(providerEventId: string): Promise<PaymentsProviderEvent> {
      return parseJsonResponse(
        await client.account["provider-events"][":providerEventId"].$get({
          param: { providerEventId },
          header: headers,
        }),
      );
    },
  };
}

export type {
  PaymentsCheckoutStatus,
  PaymentsPaymentDetail,
  PaymentsProviderEvent,
} from "./features/payments/api/contracts";
export const paymentsApi = createPaymentsApiClient();
