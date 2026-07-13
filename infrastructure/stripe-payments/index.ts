import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CreatedProcessorPayment,
  CreatedProcessorRefund,
  CreatedProcessorCustomer,
  CreatedProcessorSetupSession,
  AgenticProcessorPaymentInput,
  CreateProcessorCustomerInput,
  CreateProcessorPaymentInput,
  CreateProcessorRefundInput,
  CreateProcessorSetupSessionInput,
  PaymentProcessorGateway,
  PaymentProcessorPublicConfig,
  ProcessorDisputeEvidence,
  ProcessorPaymentDisputeLifecycleState,
  ProcessorPaymentReconciliationResult,
  PaymentProcessorWebhookEvent,
  ProcessorLiabilityShiftOutcome,
  ProcessorThreeDSecureRequest,
  ProcessorSavedPaymentMethod,
  ProcessorSetupSessionResult,
} from "@chase-sets/payment-processing";
import {
  ProviderAdapterError,
  providerFailureCategoryFromHttpStatus,
  providerFailureCategoryFromText,
  ProviderWebhookError,
} from "@chase-sets/http/provider-errors";
import { STRIPE_API_VERSION } from "@chase-sets/stripe-config";

const STRIPE_METADATA_VALUE_MAX_LENGTH = 500;
export const DEFAULT_STRIPE_STATEMENT_DESCRIPTOR_SUFFIX = "CHASESETS";
const STRIPE_STATEMENT_DESCRIPTOR_SUFFIX_PATTERN = /^[A-Za-z0-9 ._-]{1,10}$/;

export type StripePaymentProcessorGatewayOptions = Readonly<{
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  previousWebhookSecrets?: readonly string[];
  apiBaseUrl?: string;
  webhookToleranceSeconds?: number;
  statementDescriptorSuffix?: string;
}>;

type StripeCheckoutSessionResponse = Readonly<{
  id: string;
  client_secret?: string | null;
  url?: string | null;
  status?: string | null;
  mode?: string | null;
  payment_status?: string | null;
  payment_intent?: string | Readonly<StripePaymentIntentResponse> | null;
  setup_intent?: string | Readonly<{ id?: string | null }> | null;
  customer?: string | Readonly<{ id?: string | null }> | null;
  metadata?: Readonly<Record<string, string | null | undefined>> | null;
}>;

type StripePaymentIntentResponse = Readonly<{
  id: string;
  client_secret?: string | null;
  status?: string | null;
  payment_method?: string | Readonly<StripePaymentMethodResponse> | null;
  customer?: string | Readonly<{ id?: string | null }> | null;
  metadata?: Readonly<Record<string, string | null | undefined>> | null;
  next_action?: Readonly<{
    type?: string | null;
    redirect_to_url?: Readonly<{ url?: string | null }> | null;
  }> | null;
  last_payment_error?: Readonly<{
    code?: string | null;
    message?: string | null;
  }> | null;
  latest_charge?: string | Readonly<StripeChargeResponse> | null;
}>;

type StripeChargeResponse = Readonly<{
  id: string;
  payment_intent?: string | Readonly<{ id?: string | null }> | null;
  amount_refunded?: number | null;
  disputed?: boolean | null;
  metadata?: Readonly<Record<string, string | null | undefined>> | null;
  outcome?: Readonly<{
    risk_level?: string | null;
  }> | null;
  payment_method_details?: Readonly<{
    card?: Readonly<{
      three_d_secure?: Readonly<{
        result?: string | null;
      }> | null;
    }> | null;
  }> | null;
}>;

type StripeCustomerResponse = Readonly<{
  id: string;
}>;

type StripeSetupIntentResponse = Readonly<{
  id: string;
  status?: string | null;
  payment_method?: string | Readonly<StripePaymentMethodResponse> | null;
  customer?: string | Readonly<{ id?: string | null }> | null;
  last_setup_error?: Readonly<{
    code?: string | null;
    message?: string | null;
  }> | null;
}>;

type StripePaymentMethodResponse = Readonly<{
  id: string;
  type?: string | null;
  customer?: string | Readonly<{ id?: string | null }> | null;
  allow_redisplay?: "always" | "limited" | "unspecified" | null;
  card?: Readonly<{
    brand?: string | null;
    last4?: string | null;
    fingerprint?: string | null;
  }> | null;
  us_bank_account?: Readonly<{
    bank_name?: string | null;
    last4?: string | null;
  }> | null;
}>;

type StripeRefundResponse = Readonly<{
  id: string;
  status?: string | null;
}>;

type StripeDisputeResponse = Readonly<{
  id: string;
  status?: string | null;
}>;

type StripeEventEnvelope = Readonly<{
  id: string;
  type: string;
  created?: number | string;
  data?: Readonly<{
    object?: Readonly<{
      id?: string;
      status?: string | null;
      payment_status?: string | null;
      payment_intent?: string | Readonly<{ id?: string | null }> | null;
      charge?: string | Readonly<{ id?: string | null }> | null;
      setup_intent?: string | null;
      amount?: number | null;
      amount_refunded?: number | null;
      currency?: string | null;
      mode?: string | null;
      customer?: string | null;
      payment_method?: string | null;
      type?: string | null;
      allow_redisplay?: "always" | "limited" | "unspecified" | null;
      card?: Readonly<{
        brand?: string | null;
        last4?: string | null;
        fingerprint?: string | null;
      }> | null;
      us_bank_account?: Readonly<{
        bank_name?: string | null;
        last4?: string | null;
      }> | null;
      metadata?: Readonly<Record<string, string | null | undefined>> | null;
      last_payment_error?: Readonly<{
        code?: string | null;
        message?: string | null;
      }> | null;
      fraud_type?: string | null;
      actionable?: boolean | null;
      reason?: string | null;
      closed_reason?: string | null;
      outcome?: Readonly<{
        type?: string | null;
        reason?: string | null;
        risk_level?: string | null;
      }> | null;
      latest_charge?: string | Readonly<{ id?: string | null }> | null;
      payment_method_details?: Readonly<{
        card?: Readonly<{
          three_d_secure?: Readonly<{
            result?: string | null;
          }> | null;
        }> | null;
      }> | null;
      evidence_details?: Readonly<{
        due_by?: number | string | null;
      }> | null;
    }>;
  }>;
}>;

type StripeSearchResult<T> = Readonly<{
  data?: readonly T[];
}>;

type StripeWebhookObject = NonNullable<NonNullable<StripeEventEnvelope["data"]>["object"]>;

function paymentKindForStripeObject(reference: string) {
  return reference.startsWith("cs_") ? "checkout-session" : "payment-intent";
}

function metadataPaymentId(object: StripeWebhookObject) {
  return normalizeOptionalText(object.metadata?.payment_id ?? null);
}

function metadataOrderIds(object: StripeWebhookObject) {
  return (normalizeOptionalText(object.metadata?.order_ids ?? null) ?? "")
    .split(",")
    .map((orderId) => orderId.trim())
    .filter(Boolean);
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

function resolveStatementDescriptorSuffix(value?: string | null) {
  const suffix = normalizeOptionalText(value) ?? DEFAULT_STRIPE_STATEMENT_DESCRIPTOR_SUFFIX;
  if (!STRIPE_STATEMENT_DESCRIPTOR_SUFFIX_PATTERN.test(suffix)) {
    throw new Error(
      "Stripe statement descriptor suffix must be 1-10 characters and contain only letters, numbers, spaces, periods, hyphens, or underscores.",
    );
  }
  return suffix;
}

function stripeCustomerEntry(providerCustomerReference?: string | null): Record<string, string> {
  const customer = normalizeOptionalText(providerCustomerReference);
  return customer ? { customer } : {};
}

function stripeSearchLiteral(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function toFormBody(entries: Record<string, string>) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(entries)) {
    params.set(key, value);
  }

  return params;
}

function boundedOrderIdsMetadataValue(orderIds: readonly string[]) {
  const included: string[] = [];

  for (const orderId of orderIds) {
    const nextValue = [...included, orderId].join(",");
    if (nextValue.length > STRIPE_METADATA_VALUE_MAX_LENGTH) {
      break;
    }
    included.push(orderId);
  }

  return {
    orderIds: included.join(","),
    truncated: included.length < orderIds.length,
  };
}

function paymentMetadataEntries(
  input: Pick<CreateProcessorPaymentInput, "paymentId" | "buyerAccountId" | "orderIds" | "paymentMethodCategory">,
  extra: Readonly<Record<string, string | null | undefined>> = {},
  prefix = "metadata",
) {
  const orderIdsMetadata = boundedOrderIdsMetadataValue(input.orderIds);
  return {
    [`${prefix}[payment_id]`]: input.paymentId,
    [`${prefix}[buyer_account_id]`]: input.buyerAccountId,
    [`${prefix}[order_ids]`]: orderIdsMetadata.orderIds,
    [`${prefix}[order_count]`]: String(input.orderIds.length),
    ...(orderIdsMetadata.truncated ? { [`${prefix}[order_ids_truncated]`]: "true" } : {}),
    [`${prefix}[payment_method_category]`]: input.paymentMethodCategory,
    [`${prefix}[explicit_payment_method_selection]`]: "true",
    ...Object.fromEntries(
      Object.entries(extra).flatMap(([key, value]) => (value?.trim() ? [[`${prefix}[${key}]`, value.trim()]] : [])),
    ),
  };
}

function stripeMetadataValue(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized.slice(0, STRIPE_METADATA_VALUE_MAX_LENGTH) : null;
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

function disputeEvidenceEntries(evidence: ProcessorDisputeEvidence) {
  const fields: Record<string, string | null | undefined> = {
    customer_email_address: evidence.customerEmailAddress,
    customer_name: evidence.customerName,
    product_description: evidence.productDescription,
    shipping_address: evidence.shippingAddress,
    shipping_carrier: evidence.shippingCarrier,
    shipping_date: evidence.shippingDate,
    shipping_tracking_number: evidence.shippingTrackingNumber,
    uncategorized_text: evidence.uncategorizedText,
  };

  return Object.fromEntries(
    Object.entries(fields).flatMap(([key, value]) => {
      const normalized = normalizeOptionalText(value ?? null);
      return normalized ? [[`evidence[${key}]`, normalized]] : [];
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

// Off-session confirmation of a saved payment method can trigger a 3-D Secure / SCA challenge.
// Stripe returns `status: "requires_action"` with a hosted authentication page in
// `next_action.redirect_to_url.url`. Surfacing that URL is what lets Checkout hand a 3DS challenge
// back to the human as a hosted link instead of silently stalling the payment.
function paymentIntentAuthenticationUrl(intent: StripePaymentIntentResponse): string | null {
  const url = normalizeOptionalText(intent.next_action?.redirect_to_url?.url ?? null);
  if (!url) {
    return null;
  }
  return /^https:\/\//i.test(url) ? url : null;
}

function mapPaymentIntentReconciliationResult(
  intent: StripePaymentIntentResponse,
): ProcessorPaymentReconciliationResult | null {
  const processorPaymentReference = normalizeOptionalText(intent.id);
  if (!processorPaymentReference) {
    return null;
  }
  const processorStatus = normalizeOptionalText(intent.status) ?? "unknown";
  const outcome: ProcessorPaymentReconciliationResult["outcome"] =
    processorStatus === "succeeded"
      ? "captured"
      : processorStatus === "requires_capture"
        ? "authorized"
        : processorStatus === "canceled"
          ? "cancelled"
          : processorStatus === "requires_payment_method" && intent.last_payment_error
            ? "failed"
            : ["processing", "requires_action", "requires_confirmation", "requires_payment_method"].includes(
                  processorStatus,
                )
              ? "pending"
              : "unknown";
  return {
    processorName: "stripe",
    processorPaymentKind: "payment-intent",
    processorPaymentReference,
    processorStatus,
    outcome,
    occurredAt: new Date().toISOString(),
    internalPaymentId: normalizeOptionalText(
      intent.metadata?.payment_id ?? null,
    ) as ProcessorPaymentReconciliationResult["internalPaymentId"],
    failureCode: normalizeOptionalText(intent.last_payment_error?.code ?? null),
    failureMessage: normalizeOptionalText(intent.last_payment_error?.message ?? null),
  };
}

function mapCheckoutSessionReconciliationResult(
  session: StripeCheckoutSessionResponse,
  paymentIntent: StripePaymentIntentResponse | null,
): ProcessorPaymentReconciliationResult | null {
  const processorPaymentReference = normalizeOptionalText(session.id);
  if (!processorPaymentReference) {
    return null;
  }

  const sessionStatus = normalizeOptionalText(session.status);
  const paymentStatus = normalizeOptionalText(session.payment_status);
  const intentResult = paymentIntent ? mapPaymentIntentReconciliationResult(paymentIntent) : null;
  const processorStatus = paymentStatus ?? sessionStatus ?? intentResult?.processorStatus ?? "unknown";
  const outcome: ProcessorPaymentReconciliationResult["outcome"] =
    paymentStatus === "paid" || intentResult?.outcome === "captured"
      ? "captured"
      : sessionStatus === "expired"
        ? "cancelled"
        : intentResult?.outcome === "failed"
          ? "failed"
          : sessionStatus === "complete"
            ? "authorized"
            : sessionStatus === "open" || intentResult?.outcome === "pending"
              ? "pending"
              : (intentResult?.outcome ?? "unknown");

  return {
    processorName: "stripe",
    processorPaymentKind: "checkout-session",
    processorPaymentReference,
    processorStatus,
    outcome,
    occurredAt: new Date().toISOString(),
    internalPaymentId: (normalizeOptionalText(session.metadata?.payment_id ?? null) ??
      intentResult?.internalPaymentId ??
      null) as ProcessorPaymentReconciliationResult["internalPaymentId"],
    failureCode: intentResult?.failureCode ?? null,
    failureMessage: intentResult?.failureMessage ?? null,
  };
}

function paymentIntentReferenceFromCharge(charge: StripeChargeResponse) {
  const paymentIntent = charge.payment_intent;
  if (typeof paymentIntent === "string") {
    return normalizeOptionalText(paymentIntent);
  }
  return normalizeOptionalText(paymentIntent?.id ?? null);
}

function stripeObjectReference(value: string | Readonly<{ id?: string | null }> | null | undefined) {
  if (typeof value === "string") {
    return normalizeOptionalText(value);
  }
  return normalizeOptionalText(value?.id ?? null);
}

function threeDSecureRequestedFromMetadata(
  metadata: Readonly<Record<string, string | null | undefined>> | null | undefined,
): ProcessorThreeDSecureRequest | null {
  const requested = normalizeOptionalText(metadata?.three_d_secure_requested ?? null);
  return requested === "any" || requested === "automatic" ? requested : null;
}

function liabilityStatusFromThreeDSecureResult(result: string | null): ProcessorLiabilityShiftOutcome["status"] | null {
  switch (result) {
    case "authenticated":
      return "shifted";
    case "attempt_acknowledged":
      return "attempted";
    case "failed":
      return "authentication-failed";
    case "not_supported":
    case "processing_error":
      return "not-shifted";
    default:
      return null;
  }
}

function liabilityShiftOutcomeFromCharge(
  charge: Pick<StripeChargeResponse, "metadata" | "outcome" | "payment_method_details">,
  fallbackThreeDSecureRequested?: ProcessorThreeDSecureRequest | null,
): ProcessorLiabilityShiftOutcome | null {
  const authenticationResult = normalizeOptionalText(
    charge.payment_method_details?.card?.three_d_secure?.result ?? null,
  );
  const threeDSecureRequested =
    threeDSecureRequestedFromMetadata(charge.metadata) ?? fallbackThreeDSecureRequested ?? null;
  const status = liabilityStatusFromThreeDSecureResult(authenticationResult);
  if (!threeDSecureRequested && !status && !authenticationResult) {
    return null;
  }

  return {
    threeDSecureRequested,
    status: status ?? (threeDSecureRequested === "any" ? "requested" : "unknown"),
    authenticationResult,
    radarRiskLevel: normalizeOptionalText(charge.outcome?.risk_level ?? null),
  };
}

function liabilityShiftOutcomeFromFailure(object: StripeWebhookObject): ProcessorLiabilityShiftOutcome | null {
  const threeDSecureRequested = threeDSecureRequestedFromMetadata(object.metadata);
  const failureCode = normalizeOptionalText(object.last_payment_error?.code ?? null);
  if (!threeDSecureRequested || !failureCode?.includes("authentication")) {
    return null;
  }

  return {
    threeDSecureRequested,
    status: "authentication-failed",
    authenticationResult: "failed",
    radarRiskLevel: normalizeOptionalText(object.outcome?.risk_level ?? null),
  };
}

function cardAuthenticationEntries(input: Pick<CreateProcessorPaymentInput, "cardAuthentication">, prefix = "") {
  if (input.cardAuthentication?.requestThreeDSecure !== "any") {
    return {};
  }
  const fieldPrefix = prefix ? `${prefix}[` : "";
  const fieldSuffix = prefix ? "]" : "";
  return {
    [`${fieldPrefix}payment_method_options${fieldSuffix}[card][request_three_d_secure]`]: "any",
  };
}

function cardAuthenticationMetadataEntries(
  input: Pick<CreateProcessorPaymentInput, "cardAuthentication">,
  prefix = "metadata",
) {
  const authentication = input.cardAuthentication;
  if (!authentication) {
    return {};
  }
  return {
    [`${prefix}[three_d_secure_requested]`]: authentication.requestThreeDSecure,
    ...(authentication.reasonCodes.length > 0
      ? { [`${prefix}[three_d_secure_reason_codes]`]: authentication.reasonCodes.join(",") }
      : {}),
  };
}

function occurredAtFromEvent(event: StripeEventEnvelope) {
  const created = event.created;
  const timestamp =
    typeof created === "number"
      ? created * 1000
      : typeof created === "string" && /^\d+$/.test(created.trim())
        ? Number.parseInt(created.trim(), 10) * 1000
        : typeof created === "string"
          ? Date.parse(created)
          : Date.now();

  return new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).toISOString();
}

function stripeTimestampToIso(value: number | string | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return new Date(Number.parseInt(value.trim(), 10) * 1000).toISOString();
  }
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }
  return null;
}

function minorUnitsToMoney(amount: number | null | undefined) {
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? (amount / 100).toFixed(2) : null;
}

function disputeLifecycleState(eventType: string, status: string | null): ProcessorPaymentDisputeLifecycleState {
  const normalizedStatus = status?.toLowerCase() ?? "";
  if (normalizedStatus === "won" || normalizedStatus === "warning_closed") {
    return "won";
  }
  if (normalizedStatus === "lost") {
    return "lost";
  }
  if (eventType === "charge.dispute.closed") {
    return "lost";
  }
  return eventType === "charge.dispute.created" ? "created" : "updated";
}

function setupIntentReferenceFromSession(session: StripeCheckoutSessionResponse) {
  const setupIntent = session.setup_intent;
  if (typeof setupIntent === "string") {
    return normalizeOptionalText(setupIntent);
  }
  return normalizeOptionalText(setupIntent?.id ?? null);
}

function customerReference(value: string | Readonly<{ id?: string | null }> | null | undefined) {
  if (typeof value === "string") {
    return normalizeOptionalText(value);
  }
  return normalizeOptionalText(value?.id ?? null);
}

function paymentMethodReference(value: string | Readonly<StripePaymentMethodResponse> | null | undefined) {
  if (typeof value === "string") {
    return normalizeOptionalText(value);
  }
  return normalizeOptionalText(value?.id ?? null);
}

function paymentMethodCategory(
  method: Pick<StripePaymentMethodResponse, "type">,
): ProcessorSavedPaymentMethod["paymentMethodCategory"] {
  return method.type === "us_bank_account" ? "bank-account" : "card";
}

function titleCase(value: string) {
  return value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function paymentMethodDisplayLabel(method: StripePaymentMethodResponse) {
  if (method.type === "us_bank_account") {
    const bankName = normalizeOptionalText(method.us_bank_account?.bank_name ?? null) ?? "Bank account";
    const last4 = normalizeOptionalText(method.us_bank_account?.last4 ?? null);
    return last4 ? `${bankName} ending in ${last4}` : bankName;
  }

  const brand = normalizeOptionalText(method.card?.brand ?? null);
  const last4 = normalizeOptionalText(method.card?.last4 ?? null);
  const label = brand ? titleCase(brand) : "Card";
  return last4 ? `${label} ending in ${last4}` : label;
}

function mapSavedPaymentMethod(method: StripePaymentMethodResponse): ProcessorSavedPaymentMethod {
  const providerReference = normalizeOptionalText(method.id);
  if (!providerReference) {
    throw new Error("Stripe payment method did not include an id.");
  }
  return {
    processorName: "stripe",
    providerCustomerReference: customerReference(method.customer),
    providerReference,
    paymentMethodFingerprint: method.type === "card" ? normalizeOptionalText(method.card?.fingerprint ?? null) : null,
    paymentMethodCategory: paymentMethodCategory(method),
    displayLabel: paymentMethodDisplayLabel(method),
    readiness: method.customer ? "ready" : "setup-required",
    allowRedisplay: method.allow_redisplay ?? "unspecified",
    removed: !method.customer,
  };
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
  const signatures = parts
    .filter((part) => part.trim().startsWith("v1="))
    .map((part) => part.split("=")[1]?.trim())
    .filter((signature): signature is string => Boolean(signature));

  if (!timestamp || signatures.length === 0) {
    throw new Error("Stripe webhook signature is malformed.");
  }

  return { timestamp, signatures };
}

function parseStripeWebhookEnvelope(rawBody: string): StripeEventEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (error) {
    throw new ProviderWebhookError(
      "schema-mismatch",
      "Stripe webhook payload is not valid JSON.",
      null,
      null,
      false,
      error,
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { id?: unknown }).id !== "string" ||
    typeof (parsed as { type?: unknown }).type !== "string"
  ) {
    throw new ProviderWebhookError(
      "schema-mismatch",
      "Stripe webhook envelope is missing its id or type.",
      null,
      null,
      false,
    );
  }

  return parsed as StripeEventEnvelope;
}

function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecrets: readonly string[],
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
  let verified = false;
  for (const webhookSecret of webhookSecrets) {
    const expectedBuffer = Buffer.from(createHmac("sha256", webhookSecret).update(payload).digest("hex"), "hex");
    for (const signature of parsed.signatures) {
      const receivedBuffer = Buffer.from(signature, "hex");
      verified =
        (expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer)) ||
        verified;
    }
  }

  if (!verified) {
    throw new Error("Stripe webhook signature verification failed.");
  }
}

function mapWebhookEvent(event: StripeEventEnvelope): PaymentProcessorWebhookEvent | null {
  const paymentObject = event.data?.object;
  if (!paymentObject) {
    return null;
  }

  const occurredAt = occurredAtFromEvent(event);
  if (event.type === "radar.early_fraud_warning.created") {
    const warningReference = normalizeOptionalText(paymentObject.id ?? null);
    const chargeReference = stripeObjectReference(paymentObject.charge);
    const paymentIntentReference = stripeObjectReference(paymentObject.payment_intent);
    const processorPaymentReference = paymentIntentReference ?? chargeReference;
    if (!warningReference || !processorPaymentReference) {
      return null;
    }
    return {
      eventId: event.id,
      kind: "payment-early-fraud-warning",
      processorName: "stripe",
      processorPaymentKind: paymentKindForStripeObject(processorPaymentReference),
      processorPaymentReference,
      providerObjectReference: warningReference,
      providerChargeReference: chargeReference,
      internalPaymentId: metadataPaymentId(paymentObject) as PaymentProcessorWebhookEvent["internalPaymentId"],
      processorStatus: normalizeOptionalText(paymentObject.status) ?? "early_fraud_warning",
      failureCode: normalizeOptionalText(paymentObject.fraud_type ?? null),
      failureMessage:
        paymentObject.actionable === false ? "Stripe marked the early fraud warning non-actionable." : null,
      chargeDisputed: null,
      fraudType: normalizeOptionalText(paymentObject.fraud_type ?? null),
      occurredAt,
    };
  }

  if (event.type === "review.opened" || event.type === "review.closed") {
    const reviewReference = normalizeOptionalText(paymentObject.id ?? null);
    const chargeReference = stripeObjectReference(paymentObject.charge);
    const paymentIntentReference = stripeObjectReference(paymentObject.payment_intent);
    const processorPaymentReference = paymentIntentReference ?? chargeReference;
    if (!reviewReference || !processorPaymentReference) {
      return null;
    }
    const reviewOutcome =
      normalizeOptionalText(paymentObject.closed_reason ?? null) ??
      normalizeOptionalText(paymentObject.outcome?.type ?? null) ??
      normalizeOptionalText(paymentObject.status ?? null);
    return {
      eventId: event.id,
      kind: event.type === "review.opened" ? "payment-fraud-review-opened" : "payment-fraud-review-closed",
      processorName: "stripe",
      processorPaymentKind: paymentKindForStripeObject(processorPaymentReference),
      processorPaymentReference,
      providerObjectReference: reviewReference,
      providerChargeReference: chargeReference,
      internalPaymentId: metadataPaymentId(paymentObject) as PaymentProcessorWebhookEvent["internalPaymentId"],
      processorStatus: normalizeOptionalText(paymentObject.status) ?? event.type,
      failureCode: normalizeOptionalText(paymentObject.reason ?? paymentObject.outcome?.reason ?? null),
      failureMessage: null,
      fraudReviewReason: normalizeOptionalText(paymentObject.reason ?? paymentObject.outcome?.reason ?? null),
      fraudReviewOutcome: reviewOutcome,
      occurredAt,
    };
  }

  if (event.type === "shared_payment.granted_token.used" || event.type === "shared_payment.granted_token.deactivated") {
    const providerObjectReference = normalizeOptionalText(paymentObject.id ?? null);
    const paymentIntentReference = stripeObjectReference(paymentObject.payment_intent);
    const reference = paymentIntentReference ?? providerObjectReference ?? event.id;
    return {
      eventId: event.id,
      kind:
        event.type === "shared_payment.granted_token.used"
          ? "shared-payment-token-used"
          : "shared-payment-token-deactivated",
      processorName: "stripe",
      processorPaymentKind: "payment-intent",
      processorPaymentReference: reference,
      providerObjectReference,
      internalPaymentId: metadataPaymentId(paymentObject) as PaymentProcessorWebhookEvent["internalPaymentId"],
      processorStatus: normalizeOptionalText(paymentObject.status) ?? event.type,
      failureCode: null,
      failureMessage: null,
      occurredAt,
    };
  }

  const processorPaymentReference = paymentObject.id?.trim();
  if (!processorPaymentReference) {
    return null;
  }

  const processorStatus = paymentObject.payment_status?.trim() ?? paymentObject.status?.trim() ?? event.type;
  const paymentStatus = normalizeOptionalText(paymentObject.payment_status)?.toLowerCase() ?? null;
  const failureCode = normalizeOptionalText(paymentObject.last_payment_error?.code ?? null);
  const failureMessage = normalizeOptionalText(paymentObject.last_payment_error?.message ?? null);
  const internalPaymentId = metadataPaymentId(paymentObject) as PaymentProcessorWebhookEvent["internalPaymentId"];
  const savedPaymentConsentId = normalizeOptionalText(paymentObject.metadata?.saved_payment_consent_id ?? null);
  const savedPaymentConsentText = normalizeOptionalText(paymentObject.metadata?.saved_payment_consent_text ?? null);

  switch (event.type) {
    case "checkout.session.completed":
      if (paymentObject.mode === "setup") {
        return {
          eventId: event.id,
          kind: "saved-payment-setup-succeeded",
          processorName: "stripe",
          processorPaymentKind: "checkout-session",
          processorPaymentReference,
          internalPaymentId,
          processorStatus,
          failureCode: null,
          failureMessage: null,
          occurredAt,
          processorSetupReference: processorPaymentReference,
          setupIntentReference: normalizeOptionalText(paymentObject.setup_intent ?? null),
          savedPaymentConsentId,
          savedPaymentConsentText,
          savedPaymentMethod: null,
        };
      }
      if (paymentStatus !== "paid") {
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
      }
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
        savedPaymentConsentId,
        savedPaymentConsentText,
      };
    case "checkout.session.async_payment_succeeded":
      if (paymentObject.mode === "setup") {
        return {
          eventId: event.id,
          kind: "saved-payment-setup-succeeded",
          processorName: "stripe",
          processorPaymentKind: "checkout-session",
          processorPaymentReference,
          internalPaymentId,
          processorStatus,
          failureCode: null,
          failureMessage: null,
          occurredAt,
          processorSetupReference: processorPaymentReference,
          setupIntentReference: normalizeOptionalText(paymentObject.setup_intent ?? null),
          savedPaymentConsentId,
          savedPaymentConsentText,
          savedPaymentMethod: null,
        };
      }
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
        savedPaymentConsentId,
        savedPaymentConsentText,
      };
    case "checkout.session.async_payment_failed":
      if (paymentObject.mode === "setup") {
        return {
          eventId: event.id,
          kind: "saved-payment-setup-failed",
          processorName: "stripe",
          processorPaymentKind: "checkout-session",
          processorPaymentReference,
          internalPaymentId,
          processorStatus,
          failureCode,
          failureMessage,
          occurredAt,
          processorSetupReference: processorPaymentReference,
          setupIntentReference: normalizeOptionalText(paymentObject.setup_intent ?? null),
          savedPaymentConsentId,
          savedPaymentConsentText,
          savedPaymentMethod: null,
        };
      }
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
    case "payment_intent.canceled":
      return {
        eventId: event.id,
        kind: "payment-cancelled",
        processorName: "stripe",
        processorPaymentKind: "payment-intent",
        processorPaymentReference,
        internalPaymentId,
        processorStatus,
        failureCode: null,
        failureMessage: "Payment intent was canceled by Stripe.",
        occurredAt,
      };
    case "setup_intent.succeeded":
      return {
        eventId: event.id,
        kind: "saved-payment-setup-succeeded",
        processorName: "stripe",
        processorPaymentKind: "payment-intent",
        processorPaymentReference,
        internalPaymentId,
        processorStatus,
        failureCode: null,
        failureMessage: null,
        occurredAt,
        processorSetupReference: null,
        setupIntentReference: processorPaymentReference,
        savedPaymentConsentId,
        savedPaymentConsentText,
        savedPaymentMethod: null,
      };
    case "setup_intent.setup_failed":
      return {
        eventId: event.id,
        kind: "saved-payment-setup-failed",
        processorName: "stripe",
        processorPaymentKind: "payment-intent",
        processorPaymentReference,
        internalPaymentId,
        processorStatus,
        failureCode,
        failureMessage,
        occurredAt,
        processorSetupReference: null,
        setupIntentReference: processorPaymentReference,
        savedPaymentConsentId,
        savedPaymentConsentText,
        savedPaymentMethod: null,
      };
    case "payment_method.detached":
      return {
        eventId: event.id,
        kind: "saved-payment-method-detached",
        processorName: "stripe",
        processorPaymentKind: "payment-intent",
        processorPaymentReference,
        internalPaymentId: null,
        processorStatus,
        failureCode: null,
        failureMessage: null,
        occurredAt,
        savedPaymentConsentId,
        savedPaymentConsentText,
        savedPaymentMethod: mapSavedPaymentMethod(paymentObject as StripePaymentMethodResponse),
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
      return null;
    case "refund.created":
    case "refund.updated": {
      if (processorStatus === "failed" || processorStatus === "canceled" || processorStatus === "cancelled") {
        return null;
      }
      const refundPaymentReference =
        stripeObjectReference(paymentObject.payment_intent) ??
        stripeObjectReference(paymentObject.charge) ??
        processorPaymentReference;
      return {
        eventId: event.id,
        kind: "payment-refunded",
        processorName: "stripe",
        processorPaymentKind: paymentKindForStripeObject(refundPaymentReference),
        processorPaymentReference: refundPaymentReference,
        providerObjectReference: processorPaymentReference,
        refundId: normalizeOptionalText(paymentObject.metadata?.refund_id ?? null),
        processorRefundReference: processorPaymentReference,
        orderIds: metadataOrderIds(paymentObject) as PaymentProcessorWebhookEvent["orderIds"],
        amount: minorUnitsToMoney(paymentObject.amount ?? null),
        refundedAmount: minorUnitsToMoney(paymentObject.amount_refunded ?? null),
        currencyCode: paymentObject.currency?.toLowerCase() === "usd" ? "usd" : null,
        internalPaymentId,
        processorStatus,
        failureCode: null,
        failureMessage: null,
        occurredAt,
      };
    }
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed": {
      const disputePaymentReference =
        stripeObjectReference(paymentObject.payment_intent) ??
        stripeObjectReference(paymentObject.charge) ??
        processorPaymentReference;
      const disputeStatus = normalizeOptionalText(paymentObject.status ?? null);
      const disputeReason = normalizeOptionalText(paymentObject.reason ?? paymentObject.outcome?.reason ?? null);
      return {
        eventId: event.id,
        kind: "payment-disputed",
        processorName: "stripe",
        processorPaymentKind: paymentKindForStripeObject(disputePaymentReference),
        processorPaymentReference: disputePaymentReference,
        providerObjectReference: processorPaymentReference,
        amount: minorUnitsToMoney(paymentObject.amount ?? null),
        currencyCode: paymentObject.currency?.toLowerCase() === "usd" ? "usd" : null,
        internalPaymentId,
        processorStatus,
        failureCode: normalizeOptionalText(event.type),
        failureMessage: disputeStatus,
        providerChargeReference: stripeObjectReference(paymentObject.charge),
        disputeLifecycleState: disputeLifecycleState(event.type, disputeStatus),
        disputeStatus,
        disputeReason,
        disputeEvidenceDueAt: stripeTimestampToIso(paymentObject.evidence_details?.due_by),
        occurredAt,
      };
    }
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
  const statementDescriptorSuffix = resolveStatementDescriptorSuffix(options.statementDescriptorSuffix);
  const webhookSecrets = [options.webhookSecret, ...(options.previousWebhookSecrets ?? [])];

  const publicConfiguration: PaymentProcessorPublicConfig = {
    processorName: "stripe",
    publishableKey: options.publishableKey,
    confirmationExperience: "processor-managed-form",
    dynamicPaymentMethods: false,
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

  async function retrievePaymentMethod(providerReference: string): Promise<ProcessorSavedPaymentMethod | null> {
    const reference = normalizeOptionalText(providerReference);
    if (!reference) {
      return null;
    }
    const method = await stripeRequest<StripePaymentMethodResponse>(
      `/v1/payment_methods/${encodeURIComponent(reference)}`,
      { method: "GET" },
    );
    return mapSavedPaymentMethod(method);
  }

  async function retrievePaymentIntentPaymentMethod(
    paymentIntentReference: string | null,
  ): Promise<ProcessorSavedPaymentMethod | null> {
    if (!paymentIntentReference) {
      return null;
    }
    const intent = await stripeRequest<StripePaymentIntentResponse>(
      `/v1/payment_intents/${encodeURIComponent(paymentIntentReference)}`,
      { method: "GET" },
    );
    const methodReference = paymentMethodReference(intent.payment_method);
    if (!methodReference) {
      return null;
    }
    return retrievePaymentMethod(methodReference);
  }

  async function retrieveLiabilityShiftOutcomeForIntent(
    intent: StripePaymentIntentResponse,
  ): Promise<ProcessorLiabilityShiftOutcome | null> {
    const latestCharge = intent.latest_charge;
    if (!latestCharge) {
      return null;
    }
    if (typeof latestCharge !== "string") {
      return liabilityShiftOutcomeFromCharge(latestCharge, threeDSecureRequestedFromMetadata(intent.metadata));
    }
    const chargeReference = normalizeOptionalText(latestCharge);
    if (!chargeReference) {
      return null;
    }
    const charge = await stripeRequest<StripeChargeResponse>(`/v1/charges/${encodeURIComponent(chargeReference)}`, {
      method: "GET",
    });
    return liabilityShiftOutcomeFromCharge(charge, threeDSecureRequestedFromMetadata(intent.metadata));
  }

  async function retrieveSetupIntentPaymentMethod(
    setupIntentReference: string | null,
  ): Promise<ProcessorSavedPaymentMethod | null> {
    if (!setupIntentReference) {
      return null;
    }
    const setupIntent = await stripeRequest<StripeSetupIntentResponse>(
      `/v1/setup_intents/${encodeURIComponent(setupIntentReference)}`,
      { method: "GET" },
    );
    const methodReference = paymentMethodReference(setupIntent.payment_method);
    if (!methodReference) {
      return null;
    }
    return retrievePaymentMethod(methodReference);
  }

  return {
    getPublicConfiguration() {
      return publicConfiguration;
    },
    async createCustomer(input: CreateProcessorCustomerInput): Promise<CreatedProcessorCustomer> {
      const body = await stripeRequest<StripeCustomerResponse>(
        "/v1/customers",
        {
          method: "POST",
          body: toFormBody({
            ...(input.displayName?.trim() ? { name: input.displayName.trim() } : {}),
            ...(input.email?.trim() ? { email: input.email.trim() } : {}),
            "metadata[account_id]": input.accountId,
          }),
        },
        {
          idempotencyKey: input.idempotencyKey ?? `payments:account:${input.accountId}:stripe-customer`,
        },
      );

      if (!body.id?.trim()) {
        throw new Error("Stripe did not return a customer id.");
      }

      return {
        processorName: "stripe",
        providerCustomerReference: body.id,
      };
    },
    async createSetupSession(input: CreateProcessorSetupSessionInput): Promise<CreatedProcessorSetupSession> {
      const setupReturnUrl = normalizeOptionalText(input.returnUrl) ?? "http://localhost/account/payment-methods";
      const body = await stripeRequest<StripeCheckoutSessionResponse>(
        "/v1/checkout/sessions",
        {
          method: "POST",
          body: toFormBody({
            mode: "setup",
            customer: input.providerCustomerReference,
            currency: input.currencyCode,
            ui_mode: "hosted",
            success_url: setupReturnUrl,
            cancel_url: setupReturnUrl,
            client_reference_id: input.accountId,
            "metadata[account_id]": input.accountId,
            "metadata[setup_reference]": input.consentId,
            "metadata[saved_payment_consent_id]": input.consentId,
            "metadata[saved_payment_consent_text]": input.consentText,
          }),
        },
        {
          idempotencyKey: input.idempotencyKey ?? `payments:account:${input.accountId}:setup:${input.consentId}`,
        },
      );

      if (!body.id?.trim()) {
        throw new Error("Stripe did not return a setup checkout session id.");
      }

      return {
        processorName: "stripe",
        processorSetupKind: "checkout-setup-session",
        processorSetupReference: body.id,
        processorClientSecret: body.client_secret?.trim() ?? null,
        processorRedirectUrl: body.url?.trim() ?? null,
        processorStatus: body.status?.trim() ?? "open",
      };
    },
    async retrieveSetupSessionResult(processorSetupReference: string): Promise<ProcessorSetupSessionResult> {
      const session = await stripeRequest<StripeCheckoutSessionResponse>(
        `/v1/checkout/sessions/${encodeURIComponent(processorSetupReference)}`,
        { method: "GET" },
      );
      const setupIntentReference = setupIntentReferenceFromSession(session);
      return {
        processorName: "stripe",
        processorSetupReference: session.id,
        processorStatus: session.status?.trim() ?? "unknown",
        setupIntentReference,
        savedPaymentMethod: await retrieveSetupIntentPaymentMethod(setupIntentReference),
      };
    },
    retrieveSavedPaymentMethod: retrievePaymentMethod,
    async detachSavedPaymentMethod(providerReference: string): Promise<ProcessorSavedPaymentMethod | null> {
      const reference = normalizeOptionalText(providerReference);
      if (!reference) {
        return null;
      }
      const method = await stripeRequest<StripePaymentMethodResponse>(
        `/v1/payment_methods/${encodeURIComponent(reference)}/detach`,
        { method: "POST", body: toFormBody({}) },
      );
      return mapSavedPaymentMethod(method);
    },
    async createPaymentSession(input: CreateProcessorPaymentInput): Promise<CreatedProcessorPayment> {
      const amount = moneyToMinorUnits(normalizeMoneyAmount(input.amount, "Payment amount"));
      if (input.savedCheckoutInstrument?.providerReference) {
        const body = await stripeRequest<StripePaymentIntentResponse>(
          "/v1/payment_intents",
          {
            method: "POST",
            body: toFormBody({
              amount: String(amount),
              currency: input.currencyCode,
              ...stripeCustomerEntry(
                input.savedCheckoutInstrument.providerCustomerReference ?? input.providerCustomerReference,
              ),
              payment_method: input.savedCheckoutInstrument.providerReference,
              confirm: "true",
              off_session:
                input.savedCheckoutInstrument.confirmationExperience === "off-session-token" ? "true" : "false",
              description: input.description,
              statement_descriptor_suffix: statementDescriptorSuffix,
              transfer_group: `payment:${input.paymentId}`,
              ...cardAuthenticationEntries(input),
              ...paymentMetadataEntries(input, {
                funds_strategy: "platform-held",
                transfer_group: `payment:${input.paymentId}`,
                saved_checkout_instrument_id: input.savedCheckoutInstrument.instrumentId,
                saved_checkout_instrument_confirmation: input.savedCheckoutInstrument.confirmationExperience,
              }),
              ...cardAuthenticationMetadataEntries(input),
              ...marketplaceRiskMetadataEntries(input),
            }),
          },
          {
            idempotencyKey: input.idempotencyKey ?? `payments:payment:${input.paymentId}:saved-method:create`,
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
          processorRedirectUrl: paymentIntentAuthenticationUrl(body),
          processorStatus: body.status?.trim() ?? "requires_confirmation",
        };
      }

      const paymentReturnUrl = normalizeOptionalText(input.returnUrl) ?? "http://localhost/account/payments";
      const paymentMethodType = input.paymentMethodCategory === "bank-account" ? "us_bank_account" : "card";
      const body = await stripeRequest<StripeCheckoutSessionResponse>(
        "/v1/checkout/sessions",
        {
          method: "POST",
          body: toFormBody({
            mode: "payment",
            ui_mode: "elements",
            return_url: paymentReturnUrl,
            "payment_method_types[0]": paymentMethodType,
            client_reference_id: input.paymentId,
            "line_items[0][quantity]": "1",
            "line_items[0][price_data][currency]": input.currencyCode,
            "line_items[0][price_data][unit_amount]": String(amount),
            "line_items[0][price_data][product_data][name]": input.description,
            "payment_intent_data[transfer_group]": `payment:${input.paymentId}`,
            "payment_intent_data[statement_descriptor_suffix]": statementDescriptorSuffix,
            ...stripeCustomerEntry(
              input.providerCustomerReference ?? input.savePaymentMethod?.providerCustomerReference,
            ),
            ...cardAuthenticationEntries(input, "payment_intent_data"),
            ...paymentMetadataEntries(input, {}, "payment_intent_data[metadata]"),
            ...cardAuthenticationMetadataEntries(input, "payment_intent_data[metadata]"),
            ...(input.savedCheckoutInstrument
              ? {
                  "payment_intent_data[metadata][saved_checkout_instrument_id]":
                    input.savedCheckoutInstrument.instrumentId,
                  "payment_intent_data[metadata][saved_checkout_instrument_confirmation]":
                    input.savedCheckoutInstrument.confirmationExperience,
                }
              : {}),
            ...(input.savePaymentMethod
              ? {
                  customer: input.savePaymentMethod.providerCustomerReference,
                  "payment_intent_data[setup_future_usage]": "off_session",
                  "payment_intent_data[metadata][saved_payment_consent_id]": input.savePaymentMethod.consentId,
                  "metadata[saved_payment_consent_id]": input.savePaymentMethod.consentId,
                  "metadata[saved_payment_consent_text]": input.savePaymentMethod.consentText,
                }
              : {}),
            ...marketplaceRiskMetadataEntries(input, "payment_intent_data[metadata]"),
            ...paymentMetadataEntries(input),
            ...cardAuthenticationMetadataEntries(input),
            ...(input.savedCheckoutInstrument
              ? {
                  "metadata[saved_checkout_instrument_id]": input.savedCheckoutInstrument.instrumentId,
                  "metadata[saved_checkout_instrument_confirmation]":
                    input.savedCheckoutInstrument.confirmationExperience,
                }
              : {}),
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
            ...stripeCustomerEntry(input.providerCustomerReference),
            shared_payment_granted_token: input.agenticPayment.sharedPaymentGrantedToken,
            confirm: "true",
            description: input.description,
            statement_descriptor_suffix: statementDescriptorSuffix,
            transfer_group: `payment:${input.paymentId}`,
            ...cardAuthenticationEntries(input),
            ...paymentMetadataEntries(input, {
              funds_strategy: "platform-held",
              transfer_group: `payment:${input.paymentId}`,
              ucp_payment_handler: "stripe-shared-payment-token",
              ap2_checkout_mandate_id: input.agenticPayment.ap2CheckoutMandateId,
              ap2_payment_mandate_id: input.agenticPayment.ap2PaymentMandateId,
            }),
            ...cardAuthenticationMetadataEntries(input),
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
    async retrievePaymentResult(processorPaymentReference: string) {
      const reference = normalizeOptionalText(processorPaymentReference);
      if (!reference) {
        return null;
      }

      if (reference.startsWith("cs_")) {
        const session = await stripeRequest<StripeCheckoutSessionResponse>(
          `/v1/checkout/sessions/${encodeURIComponent(reference)}`,
          { method: "GET" },
        );
        const paymentIntentReference = paymentIntentReferenceFromSession(session);
        const paymentIntent = paymentIntentReference
          ? await stripeRequest<StripePaymentIntentResponse>(
              `/v1/payment_intents/${encodeURIComponent(paymentIntentReference)}`,
              { method: "GET" },
            )
          : null;
        const result = mapCheckoutSessionReconciliationResult(session, paymentIntent);
        return result && paymentIntent
          ? {
              ...result,
              liabilityShiftOutcome: await retrieveLiabilityShiftOutcomeForIntent(paymentIntent),
            }
          : result;
      }

      const intent = await stripeRequest<StripePaymentIntentResponse>(
        `/v1/payment_intents/${encodeURIComponent(reference)}`,
        { method: "GET" },
      );
      const result = mapPaymentIntentReconciliationResult(intent);
      return result
        ? {
            ...result,
            liabilityShiftOutcome: await retrieveLiabilityShiftOutcomeForIntent(intent),
          }
        : null;
    },
    async cancelPayment(processorPaymentReference: string) {
      const reference = normalizeOptionalText(processorPaymentReference);
      if (!reference || !reference.startsWith("pi_")) {
        throw new Error("Only direct payment intents can be cancelled through the payment processor gateway.");
      }
      const intent = await stripeRequest<StripePaymentIntentResponse>(
        `/v1/payment_intents/${encodeURIComponent(reference)}/cancel`,
        { method: "POST" },
      );
      const result = mapPaymentIntentReconciliationResult(intent);
      if (!result) {
        throw new Error("Stripe payment intent cancellation did not return a payment result.");
      }
      return result;
    },
    async retrievePaymentResultByPaymentId(paymentId) {
      const normalizedPaymentId = normalizeOptionalText(paymentId);
      if (!normalizedPaymentId) {
        return null;
      }

      const query = `metadata['payment_id']:'${stripeSearchLiteral(normalizedPaymentId)}'`;
      const searchParams = new URLSearchParams({ query, limit: "1" });
      const result = await stripeRequest<StripeSearchResult<StripePaymentIntentResponse>>(
        `/v1/payment_intents/search?${searchParams.toString()}`,
        { method: "GET" },
      );
      const intent = result.data?.[0] ?? null;
      const paymentResult = intent ? mapPaymentIntentReconciliationResult(intent) : null;
      return paymentResult && intent
        ? {
            ...paymentResult,
            liabilityShiftOutcome: await retrieveLiabilityShiftOutcomeForIntent(intent),
          }
        : null;
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
            "metadata[refund_id]": input.refundId,
            "metadata[order_ids]": input.orderIds.join(","),
            "metadata[refund_reason]": input.reason,
          }),
        },
        {
          idempotencyKey: `payments:refund:${input.refundId}`,
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
    async submitDisputeEvidence(input) {
      const providerDisputeId = normalizeOptionalText(input.providerDisputeId);
      if (!providerDisputeId) {
        throw new Error("Stripe dispute evidence submission requires a dispute id.");
      }

      const body = await stripeRequest<StripeDisputeResponse>(
        `/v1/disputes/${encodeURIComponent(providerDisputeId)}`,
        {
          method: "POST",
          body: toFormBody({
            ...disputeEvidenceEntries(input.evidence),
            submit: "true",
            "metadata[payment_id]": input.paymentId,
            "metadata[processor_payment_reference]": input.processorPaymentReference,
            ...(input.providerChargeReference
              ? { "metadata[provider_charge_reference]": input.providerChargeReference }
              : {}),
          }),
        },
        {
          idempotencyKey: input.idempotencyKey ?? `payments:dispute:${providerDisputeId}:evidence`,
        },
      );

      if (!body.id?.trim()) {
        throw new Error("Stripe did not return a dispute id after evidence submission.");
      }

      return {
        processorName: "stripe",
        providerDisputeId: body.id,
        processorStatus: body.status?.trim() ?? "unknown",
        submittedAt: new Date().toISOString(),
      };
    },
    async parseWebhook(input) {
      try {
        verifyStripeSignature(input.rawBody, input.signatureHeader, webhookSecrets, webhookToleranceSeconds);
      } catch (error) {
        throw new ProviderWebhookError(
          "signature-invalid",
          error instanceof Error ? error.message : "Stripe webhook signature verification failed.",
          null,
          null,
          true,
          error,
        );
      }
      const event = parseStripeWebhookEnvelope(input.rawBody);
      const mapped = mapWebhookEvent(event);
      if (!mapped) {
        throw new ProviderWebhookError(
          "unknown-event",
          "Stripe webhook event type is not supported.",
          event.id,
          event.type,
          false,
        );
      }

      if (
        mapped.kind === "payment-early-fraud-warning" ||
        mapped.kind === "payment-fraud-review-opened" ||
        mapped.kind === "payment-fraud-review-closed"
      ) {
        const chargeReference =
          normalizeOptionalText(mapped.providerChargeReference ?? null) ??
          (mapped.processorPaymentReference.startsWith("ch_") ? mapped.processorPaymentReference : null);
        if (chargeReference) {
          const charge = await stripeRequest<StripeChargeResponse>(
            `/v1/charges/${encodeURIComponent(chargeReference)}`,
            { method: "GET" },
          );
          const paymentIntentReference = paymentIntentReferenceFromCharge(charge);
          return {
            ...mapped,
            processorPaymentKind: paymentIntentReference ? "payment-intent" : mapped.processorPaymentKind,
            processorPaymentReference: paymentIntentReference ?? mapped.processorPaymentReference,
            internalPaymentId:
              mapped.internalPaymentId ??
              (metadataPaymentId(charge as StripeWebhookObject) as PaymentProcessorWebhookEvent["internalPaymentId"]),
            providerChargeReference: chargeReference,
            chargeDisputed: Boolean(charge.disputed),
          };
        }
      }

      if (mapped.kind === "saved-payment-setup-succeeded") {
        const setupIntentReference = mapped.setupIntentReference ?? null;
        return {
          ...mapped,
          savedPaymentMethod:
            mapped.savedPaymentMethod ?? (await retrieveSetupIntentPaymentMethod(setupIntentReference)),
        };
      }

      if (mapped.kind === "payment-captured") {
        const object = event.data?.object;
        const consentId = normalizeOptionalText(object?.metadata?.saved_payment_consent_id ?? null);
        const paymentIntentReference =
          stripeObjectReference(object?.payment_intent) ??
          (mapped.processorPaymentReference.startsWith("pi_") ? mapped.processorPaymentReference : null);
        const chargeReference =
          stripeObjectReference(object?.latest_charge) ?? stripeObjectReference(object?.charge) ?? null;
        const charge = chargeReference
          ? await stripeRequest<StripeChargeResponse>(`/v1/charges/${encodeURIComponent(chargeReference)}`, {
              method: "GET",
            })
          : null;
        const liabilityShiftOutcome = charge
          ? liabilityShiftOutcomeFromCharge(charge, threeDSecureRequestedFromMetadata(object?.metadata))
          : liabilityShiftOutcomeFromCharge(object as StripeChargeResponse);
        if (consentId && paymentIntentReference) {
          return {
            ...mapped,
            liabilityShiftOutcome,
            savedPaymentMethod: await retrievePaymentIntentPaymentMethod(paymentIntentReference),
          };
        }
        if (liabilityShiftOutcome) {
          return {
            ...mapped,
            liabilityShiftOutcome,
          };
        }
      }

      if (mapped.kind === "payment-failed") {
        const liabilityShiftOutcome = liabilityShiftOutcomeFromFailure(event.data?.object as StripeWebhookObject);
        if (liabilityShiftOutcome) {
          return {
            ...mapped,
            liabilityShiftOutcome,
          };
        }
      }

      if (mapped.kind === "payment-failed") {
        const object = event.data?.object;
        const paymentIntentReference =
          typeof object?.payment_intent === "string"
            ? normalizeOptionalText(object.payment_intent)
            : mapped.processorPaymentReference.startsWith("pi_")
              ? mapped.processorPaymentReference
              : null;
        return {
          ...mapped,
          savedPaymentMethod: await retrievePaymentIntentPaymentMethod(paymentIntentReference),
        };
      }

      if (mapped.kind === "payment-refunded") {
        const object = event.data?.object;
        const chargeReference =
          stripeObjectReference(object?.charge) ??
          (mapped.processorPaymentReference.startsWith("ch_") ? mapped.processorPaymentReference : null);
        if (chargeReference && (!mapped.refundedAmount || mapped.processorPaymentReference.startsWith("ch_"))) {
          const charge = await stripeRequest<StripeChargeResponse>(
            `/v1/charges/${encodeURIComponent(chargeReference)}`,
            { method: "GET" },
          );
          const paymentIntentReference = paymentIntentReferenceFromCharge(charge);
          return {
            ...mapped,
            processorPaymentKind: paymentIntentReference ? "payment-intent" : mapped.processorPaymentKind,
            processorPaymentReference: paymentIntentReference ?? mapped.processorPaymentReference,
            refundedAmount: mapped.refundedAmount ?? minorUnitsToMoney(charge.amount_refunded ?? null),
            internalPaymentId:
              mapped.internalPaymentId ??
              (metadataPaymentId(charge as StripeWebhookObject) as PaymentProcessorWebhookEvent["internalPaymentId"]),
          };
        }
      }

      if (
        mapped.kind === "payment-disputed" &&
        mapped.processorPaymentReference.startsWith("ch_") &&
        !mapped.internalPaymentId
      ) {
        const charge = await stripeRequest<StripeChargeResponse>(
          `/v1/charges/${encodeURIComponent(mapped.processorPaymentReference)}`,
          { method: "GET" },
        );
        const paymentIntentReference = paymentIntentReferenceFromCharge(charge);
        return {
          ...mapped,
          processorPaymentKind: paymentIntentReference ? "payment-intent" : mapped.processorPaymentKind,
          processorPaymentReference: paymentIntentReference ?? mapped.processorPaymentReference,
          internalPaymentId: metadataPaymentId(
            charge as StripeWebhookObject,
          ) as PaymentProcessorWebhookEvent["internalPaymentId"],
        };
      }

      return mapped;
    },
  };
}
