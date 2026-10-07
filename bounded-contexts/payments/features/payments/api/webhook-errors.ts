import {
  ProviderWebhookError,
  type ProviderWebhookInvariantCode,
  type ProviderWebhookInvariantCommand,
} from "@chase-sets/http/provider-errors";
import { PaymentsDomainError } from "../../../support/runtime-support/common";
import { decidePayment } from "../domain/domain";

export class PaymentWebhookInvariant extends Error {
  constructor(readonly invariantCode: ProviderWebhookInvariantCode) {
    super("Payment webhook invariant rejected.");
  }
}

const permanentCommands = new Set<ProviderWebhookInvariantCommand>([
  "RecordPaymentAuthorization",
  "RecordPaymentCapture",
  "RecordPaymentFailure",
  "CancelPayment",
  "RecordPaymentEarlyFraudWarning",
  "RecordPaymentFraudReviewOpened",
  "RecordPaymentFraudReviewClosed",
  "RecordPaymentLiabilityShiftOutcome",
]);

export const decideWebhookPayment: typeof decidePayment = (state, command) => {
  try {
    return decidePayment(state, command);
  } catch (error) {
    const type = command.type as ProviderWebhookInvariantCommand;
    if (error instanceof PaymentsDomainError && error.code === "validation_failed" && permanentCommands.has(type)) {
      throw new PaymentWebhookInvariant(`${type}:validation_failed`);
    }
    throw error;
  }
};

export function paymentWebhookErrorFromUnknown(
  error: unknown,
  options: Readonly<{ providerEventId?: string | null; eventKind?: string | null }> = {},
): ProviderWebhookError {
  if (error instanceof ProviderWebhookError) return error;
  return new ProviderWebhookError(
    "handler-failure",
    "Provider webhook handler failed.",
    options.providerEventId ?? null,
    options.eventKind ?? null,
    true,
    error,
  );
}
