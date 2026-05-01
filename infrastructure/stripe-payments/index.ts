import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CreatedProcessorPayment,
  CreatedProcessorRefund,
  CreateProcessorPaymentInput,
  CreateProcessorRefundInput,
  PaymentProcessorGateway,
  PaymentProcessorPublicConfig,
  PaymentProcessorWebhookEvent,
} from "@chase-sets/payment-processing";

const STRIPE_API_VERSION = "2026-02-25.clover";

export type StripePaymentProcessorGatewayOptions = Readonly<{
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  apiBaseUrl?: string;
  webhookToleranceSeconds?: number;
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
      last_payment_error?: Readonly<{
        code?: string | null;
        message?: string | null;
      }> | null;
    }>;
  }>;
}>;

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

    throw new Error(message);
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

  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    throw new Error("Stripe webhook signature verification failed.");
  }
}

function mapWebhookEvent(event: StripeEventEnvelope): PaymentProcessorWebhookEvent | null {
  const paymentIntent = event.data?.object;
  const processorPaymentReference = paymentIntent?.id?.trim();

  if (!paymentIntent || !processorPaymentReference) {
    return null;
  }

  const processorStatus = paymentIntent.status?.trim() ?? event.type;
  const occurredAt = new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000)
    .toISOString();
  const failureCode = normalizeOptionalText(paymentIntent.last_payment_error?.code ?? null);
  const failureMessage = normalizeOptionalText(
    paymentIntent.last_payment_error?.message ?? null,
  );

  switch (event.type) {
    case "payment_intent.processing":
    case "payment_intent.amount_capturable_updated":
      return {
        eventId: event.id,
        kind: "payment-authorized",
        processorName: "stripe",
        processorPaymentReference,
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
        processorPaymentReference,
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
        processorPaymentReference,
        processorStatus,
        failureCode,
        failureMessage,
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

  const publicConfiguration: PaymentProcessorPublicConfig = {
    processorName: "stripe",
    publishableKey: options.publishableKey,
  };

  async function stripeRequest<T>(path: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    headers.set("Authorization", authorization);
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    headers.set("Stripe-Version", STRIPE_API_VERSION);

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
    async createPaymentIntent(
      input: CreateProcessorPaymentInput,
    ): Promise<CreatedProcessorPayment> {
      const amount = moneyToMinorUnits(
        normalizeMoneyAmount(input.amount, "Payment amount"),
      );
      const body = await stripeRequest<StripePaymentIntentResponse>(
        "/v1/payment_intents",
        {
          method: "POST",
          body: toFormBody({
            amount: String(amount),
            currency: input.currencyCode,
            "automatic_payment_methods[enabled]": "true",
            description: input.description,
            "metadata[payment_id]": input.paymentId,
            "metadata[buyer_account_id]": input.buyerAccountId,
            "metadata[order_ids]": input.orderIds.join(","),
          }),
        },
      );

      if (!body.id?.trim()) {
        throw new Error("Stripe did not return a payment intent id.");
      }

      return {
        processorName: "stripe",
        processorPaymentReference: body.id,
        processorClientSecret: body.client_secret?.trim() ?? null,
        processorStatus: body.status?.trim() ?? "requires_payment_method",
      };
    },
    async createRefund(
      input: CreateProcessorRefundInput,
    ): Promise<CreatedProcessorRefund> {
      const amount = moneyToMinorUnits(
        normalizeMoneyAmount(input.amount, "Refund amount"),
      );
      const body = await stripeRequest<StripeRefundResponse>("/v1/refunds", {
        method: "POST",
        body: toFormBody({
          payment_intent: input.processorPaymentReference,
          amount: String(amount),
          reason: "requested_by_customer",
          "metadata[payment_id]": input.paymentId,
          "metadata[order_ids]": input.orderIds.join(","),
          "metadata[refund_reason]": input.reason,
        }),
      });

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
      verifyStripeSignature(
        input.rawBody,
        input.signatureHeader,
        options.webhookSecret,
        webhookToleranceSeconds,
      );
      const event = JSON.parse(input.rawBody) as StripeEventEnvelope;
      return mapWebhookEvent(event);
    },
  };
}
