import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CreatedProcessorPayment,
  CreatedProcessorRefund,
  AgenticProcessorPaymentInput,
  CreateProcessorPaymentInput,
  CreateProcessorRefundInput,
  PaymentProcessorGateway,
  PaymentProcessorPublicConfig,
  PaymentProcessorWebhookEvent,
} from "@chase-sets/payment-processing";
import {
  ProviderAdapterError,
  providerFailureCategoryFromHttpStatus,
  providerFailureCategoryFromText,
} from "@chase-sets/http/provider-errors";

const STRIPE_API_VERSION = "2026-02-25.clover";

export type StripePaymentProcessorGatewayOptions = Readonly<{
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  apiBaseUrl?: string;
  checkoutUiMode?: "elements" | "hosted";
  webhookToleranceSeconds?: number;
}>;

type StripeCheckoutSessionResponse = Readonly<{
  id: string;
  client_secret?: string | null;
  url?: string | null;
  status?: string | null;
  payment_status?: string | null;
  payment_intent?: string | Readonly<{ id?: string | null }> | null;
}>;

type StripePaymentIntentResponse = Readonly<{
  id: string;
  client_secret?: string | null;
  status?: string | null;
}>;

type StripeRefundResponse = Readonly<{
  id: string;
  status?: string | null;
}>;

type StripeEventEnvelope = Readonly<{
  id: string;
  type: string;
  created?: number;
  data?: Readonly<{
    object?: Readonly<{
      id?: string;
      status?: string | null;
      payment_status?: string | null;
      payment_intent?: string | null;
      metadata?: Readonly<Record<string, string | null | undefined>> | null;
      last_payment_error?: Readonly<{
        code?: string | null;
        message?: string | null;
      }> | null;
    }>;
  }>;
}>;

type StripeWebhookObject = NonNullable<NonNullable<StripeEventEnvelope["data"]>["object"]>;

function paymentKindForStripeObject(reference: string) {
  return reference.startsWith("cs_") ? "checkout-session" : "payment-intent";
}

function metadataPaymentId(object: StripeWebhookObject) {
  return normalizeOptionalText(object.metadata?.payment_id ?? null);
}

function encodeBasicAuth(secretKey: string) {
  return Buffer.from(`${secretKey}:`).toString("base64");
}

function normalizeMoneyAmount(value: string, fieldName: string) {
  const normalized = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`${fieldName} must be a valid decimal.`);
  }
  const numeric = Number.parseFloat(normalized);
  if (numeric <= 0) {
    throw new Error(`${fieldName} must be greater than zero.`);
  }
  return numeric.toFixed(2);
}

function moneyToMinorUnits(amount: string) {
  return Math.round(Number.parseFloat(amount) * 100);
}

function normalizeOptionalText(value?: string | null) {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function toFormBody(entries: Record<string, string>) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(entries)) {
    params.set(key, value);
  }

  return params;
}

function paymentMetadataEntries(
  input: Pick<CreateProcessorPaymentInput, "paymentId" | "buyerAccountId" | "orderIds" | "paymentMethodCategory">,
  extra: Readonly<Record<string, string | null | undefined>> = {},
) {
  return {
    "metadata[payment_id]": input.paymentId,
    "metadata[buyer_account_id]": input.buyerAccountId,
    "metadata[order_ids]": input.orderIds.join(","),
    "metadata[payment_method_category]": input.paymentMethodCategory,
    ...Object.fromEntries(
      Object.entries(extra).flatMap(([key, value]) => (value?.trim() ? [[`metadata[${key}]`, value.trim()]] : [])),
    ),
  };
}

function stripeMetadataValue(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized.slice(0, 500) : null;
}

function marketplaceRiskMetadataEntries(
  input: Pick<CreateProcessorPaymentInput, "marketplaceRiskMetadata">,
  prefix = "metadata",
) {
  const metadata = input.marketplaceRiskMetadata ?? {};

  return Object.fromEntries(
    Object.entries(metadata).flatMap(([key, value]) => {
      const safeKey = key
        .trim()
        .toLowerCase()
        .replaceAll(/[^a-z0-9_]+/g, "_")
        .replaceAll(/^_+|_+$/g, "");
      const safeValue = stripeMetadataValue(value);

      return safeKey && safeValue ? [[`${prefix}[${safeKey}]`, safeValue]] : [];
    }),
  );
}

function paymentIntentReferenceFromSession(session: StripeCheckoutSessionResponse) {
  const paymentIntent = session.payment_intent;
  if (typeof paymentIntent === "string") {
    return normalizeOptionalText(paymentIntent);
  }
  return normalizeOptionalText(paymentIntent?.id ?? null);
}

async function parseStripeResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as { error?: { message?: unknown } }).error?.message === "string"
        ? (body as { error: { message: string } }).error.message
        : `Stripe request failed with status ${response.status}.`;

    throw new ProviderAdapterError(
      providerFailureCategoryFromText(message, providerFailureCategoryFromHttpStatus(response.status)),
      message,
      response.status,
    );
  }

  return body as T;
}

function parseStripeSignature(signatureHeader: string | null) {
  if (!signatureHeader) {
    throw new Error("Stripe-Signature header is required.");
  }

  const parts = signatureHeader.split(",");
  const timestamp = parts
    .find((part) => part.trim().startsWith("t="))
    ?.split("=")[1]
    ?.trim();
  const signature = parts
    .find((part) => part.trim().startsWith("v1="))
    ?.split("=")[1]
    ?.trim();

  if (!timestamp || !signature) {
    throw new Error("Stripe webhook signature is malformed.");
  }

  return { timestamp, signature };
}

function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
  toleranceSeconds: number,
) {
  const parsed = parseStripeSignature(signatureHeader);
  const timestamp = Number.parseInt(parsed.timestamp, 10);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Stripe webhook signature timestamp is malformed.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    throw new Error("Stripe webhook signature timestamp is outside tolerance.");
  }

  const payload = `${parsed.timestamp}.${rawBody}`;
  const expected = createHmac("sha256", webhookSecret).update(payload).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(parsed.signature, "hex");

  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
    throw new Error("Stripe webhook signature verification failed.");
  }
}

function mapWebhookEvent(event: StripeEventEnvelope): PaymentProcessorWebhookEvent | null {
  const paymentObject = event.data?.object;
  const processorPaymentReference = paymentObject?.id?.trim();

  if (!paymentObject || !processorPaymentReference) {
    return null;
  }

  const processorStatus = paymentObject.payment_status?.trim() ?? paymentObject.status?.trim() ?? event.type;
  const occurredAt = new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const failureCode = normalizeOptionalText(paymentObject.last_payment_error?.code ?? null);
  const failureMessage = normalizeOptionalText(paymentObject.last_payment_error?.message ?? null);
  const internalPaymentId = metadataPaymentId(paymentObject) as PaymentProcessorWebhookEvent["internalPaymentId"];

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return {
        eventId: event.id,
        kind: "payment-captured",
        processorName: "stripe",
        processorPaymentKind: paymentKindForStripeObject(processorPaymentReference),
        processorPaymentReference,
        internalPaymentId,
        processorStatus,
        failureCode: null,
        failureMessage: null,
        occurredAt,
      };
    case "checkout.session.async_payment_failed":
      return {
        eventId: event.id,
        kind: "payment-failed",
        processorName: "stripe",
        processorPaymentKind: paymentKindForStripeObject(processorPaymentReference),
        processorPaymentReference,
        internalPaymentId,
        processorStatus,
        failureCode,
        failureMessage,
        occurredAt,
      };
    case "checkout.session.expired":
      return {
        eventId: event.id,
        kind: "payment-cancelled",
        processorName: "stripe",
        processorPaymentKind: paymentKindForStripeObject(processorPaymentReference),
        processorPaymentReference,
        internalPaymentId,
        processorStatus,
        failureCode: null,
        failureMessage: "Payment session expired before confirmation.",
        occurredAt,
      };
    case "payment_intent.processing":
    case "payment_intent.amount_capturable_updated":
      return {
        eventId: event.id,
        kind: "payment-authorized",
        processorName: "stripe",
        processorPaymentKind: paymentKindForStripeObject(processorPaymentReference),
        processorPaymentReference,
        internalPaymentId,
        processorStatus,
        failureCode: null,
        failureMessage: null,
        occurredAt,
      };
    case "payment_intent.succeeded":
      return {
        eventId: event.id,
        kind: "payment-captured",
        processorName: "stripe",
        processorPaymentKind: paymentKindForStripeObject(processorPaymentReference),
        processorPaymentReference,
        internalPaymentId,
        processorStatus,
        failureCode: null,
        failureMessage: null,
        occurredAt,
      };
    case "payment_intent.payment_failed":
      return {
        eventId: event.id,
        kind: "payment-failed",
        processorName: "stripe",
        processorPaymentKind: paymentKindForStripeObject(processorPaymentReference),
        processorPaymentReference,
        internalPaymentId,
        processorStatus,
        failureCode,
        failureMessage,
        occurredAt,
      };
    case "charge.refunded":
      return {
        eventId: event.id,
        kind: "payment-refunded",
        processorName: "stripe",
        processorPaymentKind: paymentKindForStripeObject(processorPaymentReference),
        processorPaymentReference,
        internalPaymentId,
        processorStatus,
        failureCode: null,
        failureMessage: null,
        occurredAt,
      };
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
      return {
        eventId: event.id,
        kind: "payment-disputed",
        processorName: "stripe",
        processorPaymentKind: paymentKindForStripeObject(processorPaymentReference),
        processorPaymentReference,
        internalPaymentId,
        processorStatus,
        failureCode: normalizeOptionalText(event.type),
        failureMessage: null,
        occurredAt,
      };
    default:
      return null;
  }
}

export function createStripePaymentProcessorGateway(
  options: StripePaymentProcessorGatewayOptions,
): PaymentProcessorGateway {
  const apiBaseUrl = options.apiBaseUrl?.trim() || "https://api.stripe.com";
  const authorization = `Basic ${encodeBasicAuth(options.secretKey)}`;
  const webhookToleranceSeconds = options.webhookToleranceSeconds ?? 300;
  const checkoutUiMode = options.checkoutUiMode ?? "elements";

  const publicConfiguration: PaymentProcessorPublicConfig = {
    processorName: "stripe",
    publishableKey: options.publishableKey,
    confirmationExperience: checkoutUiMode === "hosted" ? "processor-hosted-page" : "processor-managed-form",
    dynamicPaymentMethods: true,
    sensitivePaymentDetailsHandledByProcessor: true,
    agenticPaymentHandlers: [
      {
        id: "stripe-shared-payment-token",
        provider: "stripe",
        type: "shared_payment_token",
        requiresAp2Mandate: true,
        confirmationExperience: "server-confirmed-payment-intent",
      },
    ],
  };

  async function stripeRequest<T>(
    path: string,
    init: RequestInit,
    options: Readonly<{ idempotencyKey?: string | null }> = {},
  ) {
    const headers = new Headers(init.headers);
    headers.set("Authorization", authorization);
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    headers.set("Stripe-Version", STRIPE_API_VERSION);
    if (options.idempotencyKey?.trim()) {
      headers.set("Idempotency-Key", options.idempotencyKey.trim());
    }

    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers,
    });
    return parseStripeResponse<T>(response);
  }

  return {
    getPublicConfiguration() {
      return publicConfiguration;
    },
    async createPaymentSession(input: CreateProcessorPaymentInput): Promise<CreatedProcessorPayment> {
      const amount = moneyToMinorUnits(normalizeMoneyAmount(input.amount, "Payment amount"));
      const paymentReturnUrl = normalizeOptionalText(input.returnUrl) ?? "http://localhost/account/payments";
      const sessionNavigation: Record<string, string> =
        checkoutUiMode === "hosted"
          ? {
              ui_mode: "hosted",
              success_url: paymentReturnUrl,
              cancel_url: paymentReturnUrl,
            }
          : {
              ui_mode: "elements",
              return_url: paymentReturnUrl,
            };
      const paymentMethodType = input.paymentMethodCategory === "bank-account" ? "us_bank_account" : "card";
      const body = await stripeRequest<StripeCheckoutSessionResponse>(
        "/v1/checkout/sessions",
        {
          method: "POST",
          body: toFormBody({
            mode: "payment",
            ...sessionNavigation,
            "payment_method_types[0]": paymentMethodType,
            client_reference_id: input.paymentId,
            "line_items[0][quantity]": "1",
            "line_items[0][price_data][currency]": input.currencyCode,
            "line_items[0][price_data][unit_amount]": String(amount),
            "line_items[0][price_data][product_data][name]": input.description,
            "payment_intent_data[payment_method_options][card][request_three_d_secure]": "automatic",
            "payment_intent_data[transfer_group]": `payment:${input.paymentId}`,
            "payment_intent_data[metadata][payment_id]": input.paymentId,
            "payment_intent_data[metadata][buyer_account_id]": input.buyerAccountId,
            "payment_intent_data[metadata][order_ids]": input.orderIds.join(","),
            "payment_intent_data[metadata][payment_method_category]": input.paymentMethodCategory,
            ...marketplaceRiskMetadataEntries(input, "payment_intent_data[metadata]"),
            description: input.description,
            ...paymentMetadataEntries(input),
            "metadata[funds_strategy]": "platform-held",
            "metadata[transfer_group]": `payment:${input.paymentId}`,
            "metadata[client_ip_collected]": input.clientRiskContext?.ipAddress ? "true" : "false",
            "metadata[user_agent_collected]": input.clientRiskContext?.userAgent ? "true" : "false",
            ...marketplaceRiskMetadataEntries(input),
          }),
        },
        {
          idempotencyKey: input.idempotencyKey ?? `payments:payment:${input.paymentId}:create`,
        },
      );

      if (!body.id?.trim()) {
        throw new Error("Stripe did not return a checkout session id.");
      }

      return {
        processorName: "stripe",
        processorPaymentKind: "checkout-session",
        processorPaymentReference: body.id,
        processorClientSecret: body.client_secret?.trim() ?? null,
        processorRedirectUrl: body.url?.trim() ?? null,
        processorStatus: body.payment_status?.trim() ?? body.status?.trim() ?? "open",
      };
    },
    async createAgenticPaymentSession(input: AgenticProcessorPaymentInput): Promise<CreatedProcessorPayment> {
      const amount = moneyToMinorUnits(normalizeMoneyAmount(input.amount, "Payment amount"));
      const body = await stripeRequest<StripePaymentIntentResponse>(
        "/v1/payment_intents",
        {
          method: "POST",
          body: toFormBody({
            amount: String(amount),
            currency: input.currencyCode,
            shared_payment_granted_token: input.agenticPayment.sharedPaymentGrantedToken,
            confirm: "true",
            description: input.description,
            transfer_group: `payment:${input.paymentId}`,
            ...paymentMetadataEntries(input, {
              funds_strategy: "platform-held",
              transfer_group: `payment:${input.paymentId}`,
              ucp_payment_handler: "stripe-shared-payment-token",
              ap2_checkout_mandate_id: input.agenticPayment.ap2CheckoutMandateId,
              ap2_payment_mandate_id: input.agenticPayment.ap2PaymentMandateId,
            }),
            ...marketplaceRiskMetadataEntries(input),
          }),
        },
        {
          idempotencyKey: input.idempotencyKey ?? `payments:payment:${input.paymentId}:agentic:create`,
        },
      );

      if (!body.id?.trim()) {
        throw new Error("Stripe did not return a payment intent id.");
      }

      return {
        processorName: "stripe",
        processorPaymentKind: "payment-intent",
        processorPaymentReference: body.id,
        processorClientSecret: body.client_secret?.trim() ?? null,
        processorRedirectUrl: null,
        processorStatus: body.status?.trim() ?? "requires_confirmation",
      };
    },
    async createRefund(input: CreateProcessorRefundInput): Promise<CreatedProcessorRefund> {
      const amount = moneyToMinorUnits(normalizeMoneyAmount(input.amount, "Refund amount"));
      const paymentIntentReference = input.processorPaymentReference.startsWith("cs_")
        ? paymentIntentReferenceFromSession(
            await stripeRequest<StripeCheckoutSessionResponse>(
              `/v1/checkout/sessions/${encodeURIComponent(input.processorPaymentReference)}`,
              { method: "GET" },
            ),
          )
        : input.processorPaymentReference;

      if (!paymentIntentReference) {
        throw new Error("Stripe checkout session does not have a refundable payment intent.");
      }

      const body = await stripeRequest<StripeRefundResponse>(
        "/v1/refunds",
        {
          method: "POST",
          body: toFormBody({
            payment_intent: paymentIntentReference,
            amount: String(amount),
            reason: "requested_by_customer",
            "metadata[payment_id]": input.paymentId,
            "metadata[order_ids]": input.orderIds.join(","),
            "metadata[refund_reason]": input.reason,
          }),
        },
        {
          idempotencyKey: `payments:payment:${input.paymentId}:refund:${input.amount}`,
        },
      );

      if (!body.id?.trim()) {
        throw new Error("Stripe did not return a refund id.");
      }

      return {
        processorName: "stripe",
        processorRefundReference: body.id,
        processorStatus: body.status?.trim() ?? "pending",
      };
    },
    async parseWebhook(input) {
      verifyStripeSignature(input.rawBody, input.signatureHeader, options.webhookSecret, webhookToleranceSeconds);
      const event = JSON.parse(input.rawBody) as StripeEventEnvelope;
      return mapWebhookEvent(event);
    },
  };
}
