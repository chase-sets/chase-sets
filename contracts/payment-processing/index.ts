import type { AccountId, OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";

export type PaymentCurrencyCode = "usd";
export type PaymentProcessorName = "stripe";
export type ProcessorPaymentKind =
  | "checkout-session"
  | "payment-intent"
  | "balance-credit";

export type PaymentProcessorPublicConfig = Readonly<{
  processorName: PaymentProcessorName;
  publishableKey: string | null;
  confirmationExperience: "processor-managed-form";
  dynamicPaymentMethods: boolean;
  sensitivePaymentDetailsHandledByProcessor: boolean;
}>;

export type CreateProcessorPaymentInput = Readonly<{
  paymentId: PaymentId;
  buyerAccountId: AccountId;
  orderIds: readonly OrderId[];
  amount: string;
  currencyCode: PaymentCurrencyCode;
  description: string;
  returnUrl?: string | null;
  idempotencyKey?: string | null;
  clientRiskContext?: Readonly<{
    ipAddress?: string | null;
    userAgent?: string | null;
  }> | null;
}>;

export type CreatedProcessorPayment = Readonly<{
  processorName: PaymentProcessorName;
  processorPaymentKind: ProcessorPaymentKind;
  processorPaymentReference: string;
  processorClientSecret: string | null;
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
  createPaymentSession(
    input: CreateProcessorPaymentInput,
  ): Promise<CreatedProcessorPayment>;
  createRefund(
    input: CreateProcessorRefundInput,
  ): Promise<CreatedProcessorRefund>;
  parseWebhook(
    input: Readonly<{ rawBody: string; signatureHeader: string | null }>,
  ): Promise<PaymentProcessorWebhookEvent | null>;
}
