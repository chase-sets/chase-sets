import type { AccountId, OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";

export type PaymentCurrencyCode = "usd";
export type PaymentProcessorName = "stripe";
export type ProcessorPaymentKind = "checkout-session" | "payment-intent" | "balance-credit";
export type ProcessorPaymentMethodCategory = "card" | "bank-account" | "platform-credit";
export type ProcessorSavedPaymentReadiness = "ready" | "setup-required" | "removed";

export type PaymentProcessorPublicConfig = Readonly<{
  processorName: PaymentProcessorName;
  publishableKey: string | null;
  confirmationExperience: "processor-managed-form" | "processor-hosted-page";
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
  clientRiskContext?: Readonly<{
    ipAddress?: string | null;
    userAgent?: string | null;
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
  processorSetupKind: "checkout-setup-session";
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
  consentId: string;
  consentText: string;
  idempotencyKey?: string | null;
}>;

export type ProcessorSavedPaymentMethod = Readonly<{
  processorName: PaymentProcessorName;
  providerCustomerReference: string | null;
  providerReference: string;
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

export type ProcessorWebhookEventKind =
  | "payment-authorized"
  | "payment-captured"
  | "payment-failed"
  | "payment-cancelled"
  | "payment-refunded"
  | "payment-disputed"
  | "saved-payment-setup-succeeded"
  | "saved-payment-setup-failed"
  | "saved-payment-method-detached";

export type PaymentProcessorWebhookEvent = Readonly<{
  eventId: string;
  kind: ProcessorWebhookEventKind;
  processorName: PaymentProcessorName;
  processorPaymentKind: ProcessorPaymentKind;
  processorPaymentReference: string;
  providerObjectReference?: string | null;
  processorRefundReference?: string | null;
  amount?: string | null;
  currencyCode?: PaymentCurrencyCode | null;
  internalPaymentId?: PaymentId | null;
  processorStatus: string;
  failureCode: string | null;
  failureMessage: string | null;
  occurredAt: string;
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
  createRefund(input: CreateProcessorRefundInput): Promise<CreatedProcessorRefund>;
  parseWebhook(
    input: Readonly<{ rawBody: string; signatureHeader: string | null }>,
  ): Promise<PaymentProcessorWebhookEvent | null>;
}
