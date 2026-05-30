import { hc } from "hono/client";
import type { HonoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata } from "@chase-sets/http/responses";
import type { AgenticProcessorPaymentInput } from "@chase-sets/payment-processing";
import type { buildPaymentsApi } from "./api";
import type {
  PaymentsCheckoutStatus,
  PaymentsCheckoutRecoveryOptions,
  PaymentsMarketplaceCheckoutFeePolicy,
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
  paymentMethodCategory?: string | null;
  marketplaceCheckoutFeeQuoteFingerprint?: string | null;
  returnUrlPath?: string | null;
  agenticPayment?: AgenticProcessorPaymentInput["agenticPayment"] | null;
}>;

function paymentsApiErrorMessage(status: number, body: unknown) {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === "string") {
      return error;
    }
    if (error && typeof error === "object" && "message" in error) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) {
        return message;
      }
    }
  }

  return `API error ${status}`;
}

export class PaymentsApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(paymentsApiErrorMessage(status, body));
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

  return attachResponseMetadata(await response.json(), response) as T;
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
  const client = hc<PaymentsApiApp>(baseUrl, {
    fetch: configuredFetch,
  }) as unknown as HonoClientResource;
  const headers = resolveHeaders(initialHeaders);

  return {
    async createAccountPayment(body: CreateAccountPaymentRequest): Promise<PaymentsPaymentDetail> {
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
    async getPaymentMoneyTimeline(paymentId: string) {
      return parseJsonResponse(
        await client.account.payments[":id"].timeline.$get({
          param: { id: paymentId },
          header: headers,
        }),
      );
    },
    async getCheckoutStatus(
      params: Readonly<{
        orderIds: readonly string[];
        currencyCode?: string;
        requestedBalanceCreditAmount?: string | null;
        paymentMethodCategory?: string | null;
      }>,
    ): Promise<PaymentsCheckoutStatus> {
      const query = {
        orderIds: params.orderIds.join(","),
        currencyCode: params.currencyCode ?? "usd",
        requestedBalanceCreditAmount: params.requestedBalanceCreditAmount ?? undefined,
        paymentMethodCategory: params.paymentMethodCategory ?? undefined,
      };
      return parseJsonResponse(
        await client.account.checkout.status.$get({
          query,
          header: headers,
        }),
      );
    },
    async previewCheckoutStatus(
      params: Readonly<{
        amount: string;
        currencyCode?: string;
        requestedBalanceCreditAmount?: string | null;
        paymentMethodCategory?: string | null;
      }>,
    ): Promise<PaymentsCheckoutStatus> {
      return parseJsonResponse(
        await client.account.checkout["preview-status"].$get({
          query: {
            amount: params.amount,
            currencyCode: params.currencyCode ?? "usd",
            requestedBalanceCreditAmount: params.requestedBalanceCreditAmount ?? undefined,
            paymentMethodCategory: params.paymentMethodCategory ?? undefined,
          },
          header: headers,
        }),
      );
    },
    async recoverCheckoutPayment(body: CreateAccountPaymentRequest): Promise<PaymentsPaymentDetail> {
      return parseJsonResponse(
        await client.account.checkout.recover.$post({
          json: body,
          header: headers,
        }),
      );
    },
    async getCheckoutRecoveryOptions(
      params: Readonly<{
        orderIds: readonly string[];
        currencyCode?: string;
        requestedBalanceCreditAmount?: string | null;
        paymentMethodCategory?: string | null;
      }>,
    ): Promise<PaymentsCheckoutRecoveryOptions> {
      return parseJsonResponse(
        await client.account.checkout.recovery.$get({
          query: {
            orderIds: params.orderIds.join(","),
            currencyCode: params.currencyCode ?? "usd",
            requestedBalanceCreditAmount: params.requestedBalanceCreditAmount ?? undefined,
            paymentMethodCategory: params.paymentMethodCategory ?? undefined,
          },
          header: headers,
        }),
      );
    },
    async issueRefund(
      paymentId: string,
      body: Readonly<{ amount: string; reason: string; orderIds?: readonly string[] }>,
    ): Promise<Readonly<{ id: string; version: number }>> {
      return parseJsonResponse(
        await client.account.payments[":paymentId"].refunds.$post({
          param: { paymentId },
          json: body,
          header: headers,
        }),
      );
    },
    async getProviderHealth() {
      return parseJsonResponse(await client.account["provider-health"].$get({ header: headers }));
    },
    async getMarketplaceCheckoutFeePolicy(): Promise<PaymentsMarketplaceCheckoutFeePolicy> {
      return parseJsonResponse(
        await client.account["marketplace-checkout-fee-policy"].$get({
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
  PaymentsCheckoutRecoveryOptions,
  PaymentsMarketplaceCheckoutFeePolicy,
  PaymentsPaymentDetail,
  PaymentsProviderEvent,
} from "./features/payments/api/contracts";
export const paymentsApi = createPaymentsApiClient();
