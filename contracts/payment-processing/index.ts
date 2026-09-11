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

export type ProcessorSetupSessionCancellationResult =
  | Readonly<{ outcome: "cancelled"; processorStatus: "canceled" }>
  | Readonly<{ outcome: "already-terminal"; processorStatus: "canceled" | "succeeded" }>
  | Readonly<{ outcome: "not-found" }>
  | Readonly<{ outcome: "refused"; reason: "invalid-reference"; httpStatus: null }>
  | Readonly<{ outcome: "refused"; reason: "transport-failure"; httpStatus: null }>
  | Readonly<{ outcome: "refused"; reason: "provider-rejected"; httpStatus: number }>
  | Readonly<{ outcome: "refused"; reason: "unexpected-status"; httpStatus: 200 }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]) {
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

export function parseProcessorSetupSessionCancellationResult(
  value: unknown,
): ProcessorSetupSessionCancellationResult | null {
  if (!isRecord(value) || typeof value.outcome !== "string") {
    return null;
  }

  if (value.outcome === "cancelled") {
    return hasExactKeys(value, ["outcome", "processorStatus"]) && value.processorStatus === "canceled"
      ? { outcome: "cancelled", processorStatus: "canceled" }
      : null;
  }

  if (value.outcome === "already-terminal") {
    return hasExactKeys(value, ["outcome", "processorStatus"]) &&
      (value.processorStatus === "canceled" || value.processorStatus === "succeeded")
      ? { outcome: "already-terminal", processorStatus: value.processorStatus }
      : null;
  }

  if (value.outcome === "not-found") {
    return hasExactKeys(value, ["outcome"]) ? { outcome: "not-found" } : null;
  }

  if (value.outcome !== "refused" || !hasExactKeys(value, ["outcome", "reason", "httpStatus"])) {
    return null;
  }

  if (value.reason === "invalid-reference" || value.reason === "transport-failure") {
    return value.httpStatus === null ? { outcome: "refused", reason: value.reason, httpStatus: null } : null;
  }

  if (value.reason === "provider-rejected") {
    return typeof value.httpStatus === "number" &&
      Number.isInteger(value.httpStatus) &&
      value.httpStatus >= 100 &&
      value.httpStatus <= 599
      ? { outcome: "refused", reason: "provider-rejected", httpStatus: value.httpStatus }
      : null;
  }

  if (value.reason === "unexpected-status") {
    return value.httpStatus === 200 ? { outcome: "refused", reason: "unexpected-status", httpStatus: 200 } : null;
  }

  return null;
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
