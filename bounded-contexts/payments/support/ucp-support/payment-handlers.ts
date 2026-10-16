import type { PaymentProcessorPublicConfig } from "@chase-sets/payment-processing";

// Off-session completion against a payment method the buyer saved through the hosted setup rail.
// The buyer's off-session consent was captured during setup, and the agent grant's spending mandate
// governs the money movement. Payments still validates the instrument's readiness at charge time,
// so a removed or not-ready instrument can never be charged.
export type UcpPaymentCompletionDecision = Readonly<{
  kind: "headless-stored-payment-method";
  savedCheckoutInstrumentId: string;
}>;

export type UcpPaymentHandlerHandoff = Readonly<{
  payment: Readonly<{
    handlers: readonly Readonly<Record<string, unknown>>[];
    stored_payment_method: Readonly<{
      off_session_completion_enabled: boolean;
      setup_tools: readonly string[];
    }>;
  }>;
  // Returns null when the request names no saved checkout instrument; Checkout then answers with
  // its trusted checkout handoff, so an agent-provided instrument never reaches a processor payment.
  evaluateCompleteRequest: (body: Readonly<Record<string, unknown>>) => UcpPaymentCompletionDecision | null;
}>;

export function createPaymentsUcpHandoff(publicConfig: PaymentProcessorPublicConfig): UcpPaymentHandlerHandoff {
  const agenticHandlers = publicConfig.agenticPaymentHandlers ?? [];
  return {
    payment: {
      handlers: [
        {
          id: `${publicConfig.processorName}-trusted-checkout`,
          type: "processor_redirect_or_form",
          processor: publicConfig.processorName,
          confirmation_experience: publicConfig.confirmationExperience,
          dynamic_payment_methods: publicConfig.dynamicPaymentMethods,
          sensitive_payment_details_handled_by_processor: publicConfig.sensitivePaymentDetailsHandledByProcessor,
          requires_trusted_ui: true,
        },
        ...agenticHandlers.map((handler) => ({
          id: handler.id,
          type: handler.type,
          processor: handler.provider,
          confirmation_experience: handler.confirmationExperience,
          requires_trusted_ui: true,
        })),
        {
          // Stored-payment-method rail: an agent completes off-session with a card the buyer saved
          // through the hosted setup rail. A 3DS/SCA challenge is surfaced back to the human as a
          // hosted URL, so headless completion never depends on trusted UI.
          id: `${publicConfig.processorName}-stored-payment-method`,
          type: "stored_payment_method",
          processor: publicConfig.processorName,
          confirmation_experience: "off-session-token",
          requires_trusted_ui: false,
          supports_challenge_handoff: true,
        },
      ],
      stored_payment_method: {
        off_session_completion_enabled: true,
        setup_tools: ["payments.start-payment-method-setup", "payments.confirm-payment-method-setup"],
      },
    },
    evaluateCompleteRequest: (body) => {
      const savedCheckoutInstrumentId = readStoredPaymentMethodId(body);
      return savedCheckoutInstrumentId ? { kind: "headless-stored-payment-method", savedCheckoutInstrumentId } : null;
    },
  };
}

// A saved checkout instrument id (`sci_...`) from the hosted setup rail. Accepts the id from
// `payment_data`, a `payment.instruments[]` entry, or a top-level field so agents can supply it in
// whichever shape their connector emits. The `sci_` prefix disambiguates it from Stripe shared payment
// tokens (`spt_`) and matches the id that `payments.confirm-payment-method-setup` returns.
function readStoredPaymentMethodId(body: Readonly<Record<string, unknown>>) {
  const isStoredInstrumentId = (value: unknown) => {
    const text = readString(value);
    return text && text.startsWith("sci_") ? text : undefined;
  };

  const paymentData = readObject(body.payment_data);
  const fromPaymentData =
    isStoredInstrumentId(paymentData?.saved_checkout_instrument_id) ??
    isStoredInstrumentId(paymentData?.stored_payment_method_id);
  if (fromPaymentData) {
    return fromPaymentData;
  }

  const payment = readObject(body.payment);
  const instruments = Array.isArray(payment?.instruments) ? payment?.instruments : [];
  for (const instrument of instruments) {
    const entry = readObject(instrument);
    const fromInstrument =
      isStoredInstrumentId(entry?.saved_checkout_instrument_id) ??
      isStoredInstrumentId(entry?.stored_payment_method_id) ??
      (readString(entry?.type) === "stored_payment_method" ? isStoredInstrumentId(entry?.id) : undefined);
    if (fromInstrument) {
      return fromInstrument;
    }
  }

  return (
    isStoredInstrumentId(body.saved_checkout_instrument_id) ??
    isStoredInstrumentId(body.stored_payment_method_id) ??
    null
  );
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
