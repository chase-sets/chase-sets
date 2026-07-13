import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata } from "@chase-sets/http/responses";
import type { AgenticProcessorPaymentInput } from "@chase-sets/payment-processing";
import type { buildPaymentsApi } from "./api";
import type {
  PaymentsCheckoutStatus,
  PaymentsCheckoutRecoveryOptions,
  PaymentsAccountOrderInput,
  PaymentsMarketplaceCheckoutFeePolicy,
  PaymentsPaymentDetail,
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
  savedCheckoutInstrumentId?: string | null;
  savePaymentMethodForFuture?: boolean;
  returnUrlPath?: string | null;
  agenticPayment?: AgenticProcessorPaymentInput["agenticPayment"] | null;
}>;

export type PaymentsSavedCheckoutInstrument = Readonly<{
  instrument_id: string;
  account_id: string;
  payment_method_category: "card" | "bank-account" | "platform-credit";
  provider: string;
  display_label: string;
  confirmation_experience: "trusted-payment-step" | "off-session-token";
  is_default: boolean;
  readiness: "ready" | "setup-required" | "removed";
  allow_redisplay?: "always" | "limited" | "unspecified";
  consent_id?: string | null;
  removed_at?: string | null;
  created_at: string;
  updated_at: string;
}>;

export type PaymentsSavedCheckoutSetupSession = Readonly<{
  setup_reference_id: string;
  processor_setup_reference: string;
  processor_client_secret: string | null;
  processor_redirect_url: string | null;
  processor_status: string;
  processor_publishable_key?: string | null;
}>;

export type PaymentsPaymentMethodReconciliationResult = Readonly<{
  checked: number;
  updated: number;
  removed: number;
  items: readonly PaymentsSavedCheckoutInstrument[];
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
  const client = honoClientResource(
    hc<PaymentsApiApp>(baseUrl, {
      fetch: configuredFetch,
    }),
  );
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
    async listAccountOrderInputs(params: Readonly<{ orderIds: readonly string[] }>): Promise<{
      orders: readonly PaymentsAccountOrderInput[];
    }> {
      return parseJsonResponse(
        await client.account["order-inputs"].$get({
          query: {
            orderIds: params.orderIds.join(","),
          },
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
    async listSavedCheckoutInstruments(): Promise<{ items: readonly PaymentsSavedCheckoutInstrument[] }> {
      return parseJsonResponse(
        await client.account.checkout["saved-instruments"].$get({
          header: headers,
        }),
      );
    },
    async listPaymentMethods(): Promise<{ items: readonly PaymentsSavedCheckoutInstrument[] }> {
      return parseJsonResponse(
        await client.account["payment-methods"].$get({
          header: headers,
        }),
      );
    },
    async createSavedPaymentSetupSession(
      body: Readonly<{ returnUrlPath?: string | null }> = {},
    ): Promise<PaymentsSavedCheckoutSetupSession> {
      return parseJsonResponse(
        await client.account["payment-methods"]["setup-sessions"].$post({
          json: body,
          header: headers,
        }),
      );
    },
    async reconcileSavedPaymentSetupSession(
      processorSetupReference: string,
    ): Promise<{ instrument: PaymentsSavedCheckoutInstrument | null }> {
      return parseJsonResponse(
        await client.account["payment-methods"]["setup-sessions"][":processorSetupReference"].reconcile.$post({
          param: { processorSetupReference },
          header: headers,
        }),
      );
    },
    async setDefaultPaymentMethod(instrumentId: string): Promise<PaymentsSavedCheckoutInstrument> {
      return parseJsonResponse(
        await client.account["payment-methods"][":instrumentId"].default.$post({
          param: { instrumentId },
          header: headers,
        }),
      );
    },
    async removePaymentMethod(instrumentId: string): Promise<PaymentsSavedCheckoutInstrument> {
      return parseJsonResponse(
        await client.account["payment-methods"][":instrumentId"].remove.$post({
          param: { instrumentId },
          header: headers,
        }),
      );
    },
    async reconcilePaymentMethods(): Promise<PaymentsPaymentMethodReconciliationResult> {
      return parseJsonResponse(
        await client.account["payment-methods"].reconcile.$post({
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
    async getMarketplaceCheckoutFeePolicy(): Promise<PaymentsMarketplaceCheckoutFeePolicy> {
      return parseJsonResponse(
        await client.account["marketplace-checkout-fee-policy"].$get({
          header: headers,
        }),
      );
    },
  };
}

export type {
  PaymentsCheckoutStatus,
  PaymentsCheckoutRecoveryOptions,
  PaymentsAccountOrderInput,
  PaymentsMarketplaceCheckoutFeePolicy,
  PaymentsPaymentDetail,
} from "./features/payments/api/contracts";
export const paymentsApi = createPaymentsApiClient();
