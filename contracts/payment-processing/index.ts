import type { AccountId, OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";

export type PaymentCurrencyCode = "usd";
export type PaymentProcessorName = "stripe";
export type ProcessorPaymentKind = "checkout-session" | "payment-intent" | "balance-credit";
export type ProcessorPaymentMethodCategory = "card" | "bank-account" | "platform-credit";
export type ProcessorSavedPaymentReadiness = "ready" | "setup-required" | "removed";
export type ProcessorThreeDSecureRequest = "automatic" | "any";
export type ProcessorLiabilityShiftStatus =
  | "not-requested"
  | "requested"
  | "shifted"
  | "not-shifted"
  | "attempted"
  | "authentication-failed"
  | "unknown";

export type ProcessorLiabilityShiftOutcome = Readonly<{
  threeDSecureRequested: ProcessorThreeDSecureRequest | null;
  status: ProcessorLiabilityShiftStatus;
  authenticationResult: string | null;
  radarRiskLevel?: string | null;
}>;
export type ProcessorPaymentDisputeLifecycleState = "created" | "updated" | "won" | "lost";

export type PaymentProcessorPublicConfig = Readonly<{
  processorName: PaymentProcessorName;
  publishableKey: string | null;
  confirmationExperience: "processor-managed-form";
  dynamicPaymentMethods: boolean;
  sensitivePaymentDetailsHandledByProcessor: boolean;
  agenticPaymentHandlers?: readonly AgenticPaymentHandlerDeclaration[];
}>;

export type CreateProcessorPaymentInput = Readonly<{
  paymentId: PaymentId;
  buyerAccountId: AccountId;
  orderIds: readonly OrderId[];
  amount: string;
  currencyCode: PaymentCurrencyCode;
  paymentMethodCategory: ProcessorPaymentMethodCategory;
  description: string;
  returnUrl?: string | null;
  idempotencyKey?: string | null;
  providerCustomerReference?: string | null;
  clientRiskContext?: Readonly<{
    ipAddress?: string | null;
    userAgent?: string | null;
  }> | null;
  cardAuthentication?: Readonly<{
    requestThreeDSecure: ProcessorThreeDSecureRequest;
    reasonCodes: readonly string[];
  }> | null;
  marketplaceRiskMetadata?: Readonly<Record<string, string | number | boolean | null | undefined>> | null;
  savedCheckoutInstrument?: Readonly<{
    instrumentId: string;
    providerCustomerReference?: string | null;
    providerReference: string;
    confirmationExperience: "trusted-payment-step" | "off-session-token";
    displayLabel?: string | null;
  }> | null;
  savePaymentMethod?: Readonly<{
    providerCustomerReference: string;
    consentId: string;
    consentText: string;
  }> | null;
}>;

export type CreatedProcessorCustomer = Readonly<{
  processorName: PaymentProcessorName;
  providerCustomerReference: string;
}>;

export type CreateProcessorCustomerInput = Readonly<{
  accountId: AccountId;
  displayName?: string | null;
  email?: string | null;
  idempotencyKey?: string | null;
}>;

export type CreatedProcessorSetupSession = Readonly<{
  processorName: PaymentProcessorName;
  processorSetupKind: "checkout-setup-session" | "setup-intent";
  processorSetupReference: string;
  processorClientSecret: string | null;
  processorRedirectUrl: string | null;
  processorStatus: string;
}>;

export type CreateProcessorSetupSessionInput = Readonly<{
  accountId: AccountId;
  providerCustomerReference: string;
  currencyCode: PaymentCurrencyCode;
  returnUrl?: string | null;
  uiMode?: "hosted" | "embedded";
  consentId: string;
  consentText: string;
  idempotencyKey?: string | null;
}>;

export type ProcessorSavedPaymentMethod = Readonly<{
  processorName: PaymentProcessorName;
  providerCustomerReference: string | null;
  providerReference: string;
  paymentMethodFingerprint?: string | null;
  paymentMethodCategory: ProcessorPaymentMethodCategory;
  displayLabel: string;
  readiness: ProcessorSavedPaymentReadiness;
  allowRedisplay: "always" | "limited" | "unspecified";
  removed: boolean;
}>;

export type ProcessorSetupSessionResult = Readonly<{
  processorName: PaymentProcessorName;
  processorSetupReference: string;
  processorStatus: string;
  setupIntentReference: string | null;
  savedPaymentMethod: ProcessorSavedPaymentMethod | null;
}>;

export type ProcessorSetupSessionCancellationRefusalReason =
  | "invalid-reference"
  | "provider-rejected"
  | "transport-failure"
  | "unexpected-status";

/**
 * Recursively closed and bounded: no optional, free-text, or identifier field
 * is representable. `httpStatus` is `null` exactly for `invalid-reference` and
 * `transport-failure`, and an integer `100..599` for every other refusal.
 */
export type ProcessorSetupSessionCancellationResult =
  | Readonly<{ outcome: "cancelled"; processorStatus: "canceled" }>
  | Readonly<{ outcome: "already-terminal"; processorStatus: "canceled" | "succeeded" }>
  | Readonly<{ outcome: "not-found" }>
  | Readonly<{
      outcome: "refused";
      reason: ProcessorSetupSessionCancellationRefusalReason;
      httpStatus: number | null;
    }>;

const SETUP_SESSION_CANCELLATION_OUTCOMES = ["cancelled", "already-terminal", "not-found", "refused"] as const;
const SETUP_SESSION_CANCELLATION_REFUSAL_REASONS = [
  "invalid-reference",
  "provider-rejected",
  "transport-failure",
  "unexpected-status",
] as const;

export class ProcessorSetupSessionCancellationResultError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProcessorSetupSessionCancellationResultError";
  }
}

function failSetupSessionCancellationResult(path: string, detail: string): never {
  throw new ProcessorSetupSessionCancellationResultError(`Setup-session cancellation result '${path}' ${detail}.`);
}

function setupSessionCancellationResultBase(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failSetupSessionCancellationResult("result", "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    failSetupSessionCancellationResult("result", "must be a plain object");
  }
  return value as Record<string, unknown>;
}

function requireSetupSessionCancellationKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      failSetupSessionCancellationResult(path, `has unexpected field '${key}'`);
    }
  }
  for (const key of allowedKeys) {
    if (!(key in record)) {
      failSetupSessionCancellationResult(path, `is missing required field '${key}'`);
    }
  }
}

function setupSessionCancellationHttpStatus(value: unknown, path: string, mustBeNull: boolean): number | null {
  if (mustBeNull) {
    if (value !== null) {
      failSetupSessionCancellationResult(path, "must be null for this refusal reason");
    }
    return null;
  }
  if (!Number.isInteger(value) || (value as number) < 100 || (value as number) > 599) {
    failSetupSessionCancellationResult(path, "must be an integer from 100 through 599 for this refusal reason");
  }
  return value as number;
}

/**
 * The single runtime trust boundary for `cancelSetupSession` results. Every
 * implementer constructs its return value through this parser rather than
 * building the union by hand, so an unknown key, a missing key, an
 * out-of-enum value, or an out-of-bounds status raises instead of silently
 * widening the closed contract.
 */
export function parseProcessorSetupSessionCancellationResult(value: unknown): ProcessorSetupSessionCancellationResult {
  const record = setupSessionCancellationResultBase(value);
  const outcome = record.outcome;
  if (typeof outcome !== "string" || !(SETUP_SESSION_CANCELLATION_OUTCOMES as readonly string[]).includes(outcome)) {
    failSetupSessionCancellationResult("result.outcome", "must be one of the recognized cancellation outcomes");
  }

  switch (outcome as (typeof SETUP_SESSION_CANCELLATION_OUTCOMES)[number]) {
    case "cancelled": {
      requireSetupSessionCancellationKeys(record, ["outcome", "processorStatus"], "result");
      if (record.processorStatus !== "canceled") {
        failSetupSessionCancellationResult("result.processorStatus", "must be 'canceled' for a cancelled outcome");
      }
      return { outcome: "cancelled", processorStatus: "canceled" };
    }
    case "already-terminal": {
      requireSetupSessionCancellationKeys(record, ["outcome", "processorStatus"], "result");
      if (record.processorStatus !== "canceled" && record.processorStatus !== "succeeded") {
        failSetupSessionCancellationResult(
          "result.processorStatus",
          "must be 'canceled' or 'succeeded' for an already-terminal outcome",
        );
      }
      return { outcome: "already-terminal", processorStatus: record.processorStatus };
    }
    case "not-found": {
      requireSetupSessionCancellationKeys(record, ["outcome"], "result");
      return { outcome: "not-found" };
    }
    case "refused": {
      requireSetupSessionCancellationKeys(record, ["outcome", "reason", "httpStatus"], "result");
      const reason = record.reason;
      if (
        typeof reason !== "string" ||
        !(SETUP_SESSION_CANCELLATION_REFUSAL_REASONS as readonly string[]).includes(reason)
      ) {
        failSetupSessionCancellationResult("result.reason", "must be one of the recognized refusal reasons");
      }
      const typedReason = reason as ProcessorSetupSessionCancellationRefusalReason;
      const mustBeNull = typedReason === "invalid-reference" || typedReason === "transport-failure";
      const httpStatus = setupSessionCancellationHttpStatus(record.httpStatus, "result.httpStatus", mustBeNull);
      return { outcome: "refused", reason: typedReason, httpStatus };
    }
    default:
      return failSetupSessionCancellationResult("result.outcome", "is not a recognized cancellation outcome");
  }
}

export type AgenticPaymentHandlerDeclaration = Readonly<{
  id: "stripe-shared-payment-token";
  provider: "stripe";
  type: "shared_payment_token";
  requiresAp2Mandate: true;
  confirmationExperience: "server-confirmed-payment-intent";
}>;

export type AgenticProcessorPaymentInput = CreateProcessorPaymentInput &
  Readonly<{
    agenticPayment: Readonly<{
      kind: "stripe-shared-payment-token";
      sharedPaymentGrantedToken: string;
      ap2CheckoutMandateId?: string | null;
      ap2PaymentMandateId?: string | null;
    }>;
  }>;

export type CreatedProcessorPayment = Readonly<{
  processorName: PaymentProcessorName;
  processorPaymentKind: ProcessorPaymentKind;
  processorPaymentReference: string;
  processorClientSecret: string | null;
  processorRedirectUrl: string | null;
  processorStatus: string;
}>;

export type ProcessorPaymentReconciliationOutcome =
  | "pending"
  | "authorized"
  | "captured"
  | "failed"
  | "cancelled"
  | "unknown";

export type ProcessorPaymentReconciliationResult = Readonly<{
  processorName: PaymentProcessorName;
  processorPaymentKind: ProcessorPaymentKind;
  processorPaymentReference: string;
  processorStatus: string;
  outcome: ProcessorPaymentReconciliationOutcome;
  occurredAt: string;
  internalPaymentId?: PaymentId | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  liabilityShiftOutcome?: ProcessorLiabilityShiftOutcome | null;
  savedPaymentMethod?: ProcessorSavedPaymentMethod | null;
  savedPaymentConsentId?: string | null;
  savedPaymentConsentText?: string | null;
}>;

export type CreateProcessorRefundInput = Readonly<{
  refundId: string;
  paymentId: PaymentId;
  processorPaymentReference: string;
  orderIds: readonly OrderId[];
  amount: string;
  currencyCode: PaymentCurrencyCode;
  reason: string;
}>;

export type CreatedProcessorRefund = Readonly<{
  processorName: PaymentProcessorName;
  processorRefundReference: string;
  processorStatus: string;
}>;

export type ProcessorDisputeEvidence = Readonly<{
  customerEmailAddress?: string | null;
  customerName?: string | null;
  productDescription?: string | null;
  shippingAddress?: string | null;
  shippingCarrier?: string | null;
  shippingDate?: string | null;
  shippingTrackingNumber?: string | null;
  uncategorizedText?: string | null;
}>;

export type SubmitProcessorDisputeEvidenceInput = Readonly<{
  paymentId: PaymentId;
  providerDisputeId: string;
  providerChargeReference?: string | null;
  processorPaymentReference: string;
  evidence: ProcessorDisputeEvidence;
  idempotencyKey?: string | null;
}>;

export type SubmittedProcessorDisputeEvidence = Readonly<{
  processorName: PaymentProcessorName;
  providerDisputeId: string;
  processorStatus: string;
  submittedAt: string;
}>;

export type ProcessorWebhookEventKind =
  | "payment-authorized"
  | "payment-captured"
  | "payment-failed"
  | "payment-cancelled"
  | "payment-refunded"
  | "payment-disputed"
  | "payment-early-fraud-warning"
  | "payment-fraud-review-opened"
  | "payment-fraud-review-closed"
  | "saved-payment-setup-succeeded"
  | "saved-payment-setup-failed"
  | "saved-payment-method-detached"
  | "shared-payment-token-used"
  | "shared-payment-token-deactivated";

export type PaymentProcessorWebhookEvent = Readonly<{
  eventId: string;
  kind: ProcessorWebhookEventKind;
  processorName: PaymentProcessorName;
  processorPaymentKind: ProcessorPaymentKind;
  processorPaymentReference: string;
  providerObjectReference?: string | null;
  refundId?: string | null;
  processorRefundReference?: string | null;
  orderIds?: readonly OrderId[] | null;
  amount?: string | null;
  refundedAmount?: string | null;
  currencyCode?: PaymentCurrencyCode | null;
  internalPaymentId?: PaymentId | null;
  processorStatus: string;
  failureCode: string | null;
  failureMessage: string | null;
  occurredAt: string;
  providerChargeReference?: string | null;
  chargeDisputed?: boolean | null;
  disputeLifecycleState?: ProcessorPaymentDisputeLifecycleState | null;
  disputeStatus?: string | null;
  disputeReason?: string | null;
  disputeEvidenceDueAt?: string | null;
  fraudType?: string | null;
  fraudReviewReason?: string | null;
  fraudReviewOutcome?: string | null;
  liabilityShiftOutcome?: ProcessorLiabilityShiftOutcome | null;
  savedPaymentMethod?: ProcessorSavedPaymentMethod | null;
  savedPaymentConsentId?: string | null;
  savedPaymentConsentText?: string | null;
  processorSetupReference?: string | null;
  setupIntentReference?: string | null;
}>;

export interface PaymentProcessorGateway {
  getPublicConfiguration(): PaymentProcessorPublicConfig;
  createCustomer(input: CreateProcessorCustomerInput): Promise<CreatedProcessorCustomer>;
  createSetupSession(input: CreateProcessorSetupSessionInput): Promise<CreatedProcessorSetupSession>;
  retrieveSetupSessionResult(processorSetupReference: string): Promise<ProcessorSetupSessionResult>;
  /**
   * Cancels a SetupIntent-backed setup session for test-mode cleanup. Distinct
   * from `cancelPayment`: neither method accepts the other's reference class.
   * Never throws for a recognized failure mode -- every outcome, including
   * provider and transport failures, is represented in the returned closed
   * union.
   */
  cancelSetupSession(processorSetupReference: string): Promise<ProcessorSetupSessionCancellationResult>;
  retrieveSavedPaymentMethod(providerReference: string): Promise<ProcessorSavedPaymentMethod | null>;
  detachSavedPaymentMethod(providerReference: string): Promise<ProcessorSavedPaymentMethod | null>;
  /**
   * Creates the provider-managed payment confirmation surface.
   *
   * Implementations may use a Checkout Session, PaymentIntent, or another
   * provider-native primitive as long as sensitive payment details stay with the
   * processor and the returned reference is the stable webhook lookup key.
   */
  createPaymentSession(input: CreateProcessorPaymentInput): Promise<CreatedProcessorPayment>;
  createAgenticPaymentSession?(input: AgenticProcessorPaymentInput): Promise<CreatedProcessorPayment>;
  cancelPayment(processorPaymentReference: string): Promise<ProcessorPaymentReconciliationResult>;
  retrievePaymentResult(processorPaymentReference: string): Promise<ProcessorPaymentReconciliationResult | null>;
  retrievePaymentResultByPaymentId?(paymentId: PaymentId): Promise<ProcessorPaymentReconciliationResult | null>;
  createRefund(input: CreateProcessorRefundInput): Promise<CreatedProcessorRefund>;
  submitDisputeEvidence?(input: SubmitProcessorDisputeEvidenceInput): Promise<SubmittedProcessorDisputeEvidence>;
  parseWebhook(
    input: Readonly<{ rawBody: string; signatureHeader: string | null }>,
  ): Promise<PaymentProcessorWebhookEvent | null>;
}
