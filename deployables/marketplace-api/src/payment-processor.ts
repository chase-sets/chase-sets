import { createHmac, timingSafeEqual } from "node:crypto";
import {
  PaymentsDomainError,
  type PaymentProcessorGateway,
  type PaymentProcessorPublicConfig,
  type PaymentProcessorWebhookEvent,
} from "@chase-sets/payments/server";

type FakePaymentProcessorGatewayOptions = Readonly<{
  publishableKey?: string | null;
}>;

type StripeGatewayOptions = Readonly<{
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  apiBaseUrl?: string;
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

type FakeWebhookEnvelope = Readonly<{
  eventId?: string;
  kind: PaymentProcessorWebhookEvent["kind"];
  processorPaymentReference: string;
  processorStatus: string;
  failureCode?: string | null;
  failureMessage?: string | null;
  occurredAt: string;
}>;

function normalizeOptionalText(value?: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeMoneyAmount(
  value: string,
  options: Readonly<{ allowZero?: boolean; fieldName?: string }> = {},
) {
  const normalized = value.trim();
  const fieldName = options.fieldName ?? "Amount";

  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new PaymentsDomainError(`${fieldName} must be a valid decimal.`);
  }

  const numeric = Number.parseFloat(normalized);
  if (options.allowZero ? numeric < 0 : numeric <= 0) {
    throw new PaymentsDomainError(
      `${fieldName} must be ${options.allowZero ? "zero or greater" : "greater than zero"}.`,
    );
  }

  return numeric.toFixed(2);
}

function moneyToMinorUnits(value: string): number {
  const normalized = normalizeMoneyAmount(value, {
    allowZero: true,
    fieldName: "Amount",
  });

  return Math.round(Number.parseFloat(normalized) * 100);
}

function encodeBasicAuth(secretKey: string) {
  return Buffer.from(`${secretKey}:`).toString("base64");
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

    throw new PaymentsDomainError(message);
  }

  return body as T;
}

function parseStripeSignature(signatureHeader: string | null) {
  if (!signatureHeader) {
    throw new PaymentsDomainError("Stripe-Signature header is required.");
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
    throw new PaymentsDomainError("Stripe webhook signature is malformed.");
  }

  return { timestamp, signature };
}

function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
) {
  const parsed = parseStripeSignature(signatureHeader);
  const payload = `${parsed.timestamp}.${rawBody}`;
  const expected = createHmac("sha256", webhookSecret).update(payload).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(parsed.signature, "hex");

  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    throw new PaymentsDomainError("Stripe webhook signature verification failed.");
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

function createPaymentReference(input: {
  paymentId: string;
}) {
  return `pi_seed_${input.paymentId}`;
}

function createRefundReference(input: {
  paymentId: string;
  amount: string;
}) {
  return `re_seed_${input.paymentId}_${input.amount.replace(".", "_")}`;
}

export function createFakePaymentProcessorGateway(
  options: FakePaymentProcessorGatewayOptions = {},
): PaymentProcessorGateway {
  return {
    getPublicConfiguration() {
      return {
        processorName: "stripe",
        publishableKey: options.publishableKey ?? "pk_seed_offline",
      };
    },
    async createPaymentIntent(input) {
      return {
        processorName: "stripe",
        processorPaymentReference: createPaymentReference(input),
        processorClientSecret: `secret_seed_${input.paymentId}`,
        processorStatus: "requires_capture",
      };
    },
    async createRefund(input) {
      if (input.reason.trim().toLowerCase().includes("fail")) {
        throw new Error("Seeded refund failure.");
      }

      return {
        processorName: "stripe",
        processorRefundReference: createRefundReference(input),
        processorStatus: "succeeded",
      };
    },
    async parseWebhook(input) {
      if (!input.rawBody.trim()) {
        return null;
      }

      const body = JSON.parse(input.rawBody) as FakeWebhookEnvelope;
      return {
        eventId: body.eventId ?? `evt_seed_${body.kind}_${body.processorPaymentReference}`,
        kind: body.kind,
        processorName: "stripe",
        processorPaymentReference: body.processorPaymentReference,
        processorStatus: body.processorStatus,
        failureCode: body.failureCode ?? null,
        failureMessage: body.failureMessage ?? null,
        occurredAt: body.occurredAt,
      };
    },
  };
}

export function createStripePaymentProcessorGateway(
  options: StripeGatewayOptions,
): PaymentProcessorGateway {
  const apiBaseUrl = options.apiBaseUrl?.trim() || "https://api.stripe.com";
  const authorization = `Basic ${encodeBasicAuth(options.secretKey)}`;

  const publicConfiguration: PaymentProcessorPublicConfig = {
    processorName: "stripe",
    publishableKey: options.publishableKey,
  };

  return {
    getPublicConfiguration() {
      return publicConfiguration;
    },
    async createPaymentIntent(input) {
      const amount = moneyToMinorUnits(
        normalizeMoneyAmount(input.amount, { fieldName: "Payment amount" }),
      );
      const response = await fetch(`${apiBaseUrl}/v1/payment_intents`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: toFormBody({
          amount: String(amount),
          currency: input.currencyCode,
          "automatic_payment_methods[enabled]": "true",
          description: input.description,
          "metadata[payment_id]": input.paymentId,
          "metadata[buyer_account_id]": input.buyerAccountId,
          "metadata[order_ids]": input.orderIds.join(","),
        }),
      });
      const body = await parseStripeResponse<StripePaymentIntentResponse>(response);

      if (!body.id?.trim()) {
        throw new PaymentsDomainError("Stripe did not return a payment intent id.");
      }

      return {
        processorName: "stripe",
        processorPaymentReference: body.id,
        processorClientSecret: body.client_secret?.trim() ?? null,
        processorStatus: body.status?.trim() ?? "requires_payment_method",
      };
    },
    async createRefund(input) {
      const amount = moneyToMinorUnits(
        normalizeMoneyAmount(input.amount, { fieldName: "Refund amount" }),
      );
      const response = await fetch(`${apiBaseUrl}/v1/refunds`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: toFormBody({
          payment_intent: input.processorPaymentReference,
          amount: String(amount),
          reason: "requested_by_customer",
          "metadata[payment_id]": input.paymentId,
          "metadata[order_ids]": input.orderIds.join(","),
          "metadata[refund_reason]": input.reason,
        }),
      });
      const body = await parseStripeResponse<StripeRefundResponse>(response);

      if (!body.id?.trim()) {
        throw new PaymentsDomainError("Stripe did not return a refund id.");
      }

      return {
        processorName: "stripe",
        processorRefundReference: body.id,
        processorStatus: body.status?.trim() ?? "pending",
      };
    },
    async parseWebhook(input) {
      verifyStripeSignature(input.rawBody, input.signatureHeader, options.webhookSecret);
      const event = JSON.parse(input.rawBody) as StripeEventEnvelope;
      return mapWebhookEvent(event);
    },
  };
}
