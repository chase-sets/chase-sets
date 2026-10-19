import { hc } from "hono/client";
import type { ZodType } from "zod";
import { attachResponseMetadata } from "@chase-sets/http/responses";
import type { buildPaymentsApi } from "./api";
import type { CreateAccountPaymentRequest, CreateSavedPaymentSetupSessionRequest } from "./features/payments/api/route";
import {
  paymentsCheckoutRecoveryOptionsSchema,
  paymentsCheckoutStatusSchema,
  paymentsPaymentDetailSchema,
  type PaymentsCheckoutStatus,
  type PaymentsCheckoutRecoveryOptions,
  type PaymentsAccountOrderInput,
  type PaymentsMarketplaceCheckoutFeePolicy,
  type PaymentsPaymentDetail,
} from "./features/payments/api/contracts";

type PaymentsApiApp = ReturnType<typeof buildPaymentsApi>;
const DEFAULT_BASE_URL = "/api/marketplace";

export type { CreateAccountPaymentRequest, CreateSavedPaymentSetupSessionRequest };

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

export type PaymentsApiResponseIssue = Readonly<{ path: readonly PropertyKey[]; code: string }>;

/**
 * A 2xx Payments API body that did not decode. It records where and how decoding failed, never a received
 * value, because these bodies carry `processor_client_secret`.
 */
export class PaymentsApiResponseError extends PaymentsApiError {
  public constructor(public readonly issues: readonly PaymentsApiResponseIssue[]) {
    super(502, { error: { code: "internal_error", message: "Payments API returned an unexpected response." } });
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

/**
 * Hono's client spreads a header object into each request, which reads only own enumerable keys (a `Headers`
 * instance contributes none). Handing it that same view keeps every payments request's headers unchanged.
 */
function honoHeaderValues(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}));
}

type PaymentsApiResponse = Pick<Response, "ok" | "status" | "headers" | "json">;

async function parseJsonResponse<T>(response: PaymentsApiResponse): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new PaymentsApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

async function decodeJsonResponse<T extends object>(response: PaymentsApiResponse, schema: ZodType<T>): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new PaymentsApiError(response.status, errorBody);
  }

  const body: unknown = await response.json().catch((error: unknown) => {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  });
  const decoded = schema.safeParse(body);
  if (!decoded.success) {
    throw new PaymentsApiResponseError(decoded.error.issues.map(({ path, code }) => ({ path, code })));
  }

  return attachResponseMetadata(decoded.data, response);
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
    headers: honoHeaderValues(resolveHeaders(initialHeaders)),
  });

  return {
    async createAccountPayment(body: CreateAccountPaymentRequest): Promise<PaymentsPaymentDetail> {
      return decodeJsonResponse(
        await client.account.payments.$post({
          json: body,
        }),
        paymentsPaymentDetailSchema,
      );
    },
    async getAccountPayment(paymentId: string): Promise<PaymentsPaymentDetail> {
      return decodeJsonResponse(
        await client.account.payments[":id"].$get({
          param: { id: paymentId },
        }),
        paymentsPaymentDetailSchema,
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
        }),
      );
    },
    async getPaymentMoneyTimeline(paymentId: string) {
      return parseJsonResponse(
        await client.account.payments[":id"].timeline.$get({
          param: { id: paymentId },
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
      return decodeJsonResponse(
        await client.account.checkout.status.$get({
          query,
        }),
        paymentsCheckoutStatusSchema,
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
      return decodeJsonResponse(
        await client.account.checkout["preview-status"].$get({
          query: {
            amount: params.amount,
            currencyCode: params.currencyCode ?? "usd",
            requestedBalanceCreditAmount: params.requestedBalanceCreditAmount ?? undefined,
            paymentMethodCategory: params.paymentMethodCategory ?? undefined,
          },
        }),
        paymentsCheckoutStatusSchema,
      );
    },
    async listSavedCheckoutInstruments(): Promise<{ items: readonly PaymentsSavedCheckoutInstrument[] }> {
      return parseJsonResponse(await client.account.checkout["saved-instruments"].$get());
    },
    async listPaymentMethods(): Promise<{ items: readonly PaymentsSavedCheckoutInstrument[] }> {
      return parseJsonResponse(await client.account["payment-methods"].$get());
    },
    async createSavedPaymentSetupSession(
      body: CreateSavedPaymentSetupSessionRequest = {},
    ): Promise<PaymentsSavedCheckoutSetupSession> {
      return parseJsonResponse(
        await client.account["payment-methods"]["setup-sessions"].$post({
          json: body,
        }),
      );
    },
    async reconcileSavedPaymentSetupSession(
      processorSetupReference: string,
    ): Promise<{ instrument: PaymentsSavedCheckoutInstrument | null }> {
      return parseJsonResponse(
        await client.account["payment-methods"]["setup-sessions"][":processorSetupReference"].reconcile.$post({
          param: { processorSetupReference },
        }),
      );
    },
    async setDefaultPaymentMethod(instrumentId: string): Promise<PaymentsSavedCheckoutInstrument> {
      return parseJsonResponse(
        await client.account["payment-methods"][":instrumentId"].default.$post({
          param: { instrumentId },
        }),
      );
    },
    async removePaymentMethod(instrumentId: string): Promise<PaymentsSavedCheckoutInstrument> {
      return parseJsonResponse(
        await client.account["payment-methods"][":instrumentId"].remove.$post({
          param: { instrumentId },
        }),
      );
    },
    async reconcilePaymentMethods(): Promise<PaymentsPaymentMethodReconciliationResult> {
      return parseJsonResponse(await client.account["payment-methods"].reconcile.$post());
    },
    async recoverCheckoutPayment(body: CreateAccountPaymentRequest): Promise<PaymentsPaymentDetail> {
      return decodeJsonResponse(
        await client.account.checkout.recover.$post({
          json: body,
        }),
        paymentsPaymentDetailSchema,
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
      return decodeJsonResponse(
        await client.account.checkout.recovery.$get({
          query: {
            orderIds: params.orderIds.join(","),
            currencyCode: params.currencyCode ?? "usd",
            requestedBalanceCreditAmount: params.requestedBalanceCreditAmount ?? undefined,
            paymentMethodCategory: params.paymentMethodCategory ?? undefined,
          },
        }),
        paymentsCheckoutRecoveryOptionsSchema,
      );
    },
    async getMarketplaceCheckoutFeePolicy(): Promise<PaymentsMarketplaceCheckoutFeePolicy> {
      return parseJsonResponse(await client.account["marketplace-checkout-fee-policy"].$get());
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
