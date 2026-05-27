import type { AccountId, OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";

export type PaymentCurrencyCode = "usd";
export type PaymentProcessorName = "stripe";
export type ProcessorPaymentKind = "checkout-session" | "payment-intent" | "balance-credit";
export type ProcessorPaymentMethodCategory = "card" | "bank-account" | "platform-credit";

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
  | "payment-disputed";

export type PaymentProcessorWebhookEvent = Readonly<{
  eventId: string;
  kind: ProcessorWebhookEventKind;
  processorName: PaymentProcessorName;
  processorPaymentKind: ProcessorPaymentKind;
  processorPaymentReference: string;
  internalPaymentId?: PaymentId | null;
  processorStatus: string;
  failureCode: string | null;
  failureMessage: string | null;
  occurredAt: string;
}>;

export interface PaymentProcessorGateway {
  getPublicConfiguration(): PaymentProcessorPublicConfig;
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
