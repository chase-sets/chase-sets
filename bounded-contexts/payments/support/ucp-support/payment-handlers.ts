import { createUcpEnvelope, type UcpEnvelope } from "@chase-sets/platform-runtime/ucp";
import type { AgenticProcessorPaymentInput, PaymentProcessorPublicConfig } from "@chase-sets/payment-processing";

export type UcpAp2MandateVerificationInput = Readonly<{
  checkout: Readonly<Record<string, unknown>>;
  request: Readonly<Record<string, unknown>>;
  checkoutMandate: UcpAp2MandateArtifact;
  paymentMandate: UcpAp2MandateArtifact | null;
  paymentToken: string | null;
  verifiedAt: string;
}>;

export type UcpAp2MandateArtifact = Readonly<{
  id: string | null;
  token: string;
}>;

export type UcpAp2MandateVerificationResult =
  | Readonly<{
      ok: true;
      evidence?: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      ok: false;
      code:
        | "mandate_invalid_signature"
        | "mandate_expired"
        | "mandate_scope_mismatch"
        | "merchant_authorization_invalid"
        | "merchant_authorization_missing";
      message: string;
    }>;

export type UcpAp2MandateVerifier = Readonly<{
  verify: (
    input: UcpAp2MandateVerificationInput,
  ) => Promise<UcpAp2MandateVerificationResult> | UcpAp2MandateVerificationResult;
}>;

export type UcpPaymentCompletionDecision =
  | Readonly<{
      kind: "respond";
      response: UcpEnvelope;
    }>
  | Readonly<{
      kind: "headless-agentic-payment";
      agenticPayment: AgenticProcessorPaymentInput["agenticPayment"];
      evidence?: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      // Off-session completion against a payment method the buyer saved through the hosted
      // setup rail (#4713). No AP2 mandate is required: the buyer's off-session consent was
      // captured during setup, and the agent grant's spending mandate governs the money movement.
      // Payments still validates the instrument's readiness at charge time, so a removed or
      // not-ready instrument can never be charged.
      kind: "headless-stored-payment-method";
      savedCheckoutInstrumentId: string;
    }>;

export type UcpPaymentHandlerHandoff = Readonly<{
  payment: Readonly<{
    handlers: readonly Readonly<Record<string, unknown>>[];
    ap2: Readonly<{
      mandate_verification: "enabled" | "not-enabled";
      headless_completion_enabled: boolean;
    }>;
    stored_payment_method: Readonly<{
      off_session_completion_enabled: boolean;
      setup_tools: readonly string[];
    }>;
  }>;
  evaluateCompleteRequest: (
    body: Readonly<Record<string, unknown>>,
    checkout: Readonly<Record<string, unknown>>,
  ) => Promise<UcpPaymentCompletionDecision | null> | UcpPaymentCompletionDecision | null;
}>;

export function createPaymentsUcpHandoff(
  publicConfig: PaymentProcessorPublicConfig,
  options: Readonly<{
    ap2Verifier?: UcpAp2MandateVerifier;
  }> = {},
): UcpPaymentHandlerHandoff {
  const agenticHandlers = publicConfig.agenticPaymentHandlers ?? [];
  const canHeadlessComplete = Boolean(options.ap2Verifier && agenticHandlers.length > 0);
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
          requires_ap2_mandate: handler.requiresAp2Mandate,
          requires_trusted_ui: !canHeadlessComplete,
        })),
        {
          // Stored-payment-method rail: an agent completes off-session with a card the buyer saved
          // through the hosted setup rail. A 3DS/SCA challenge is surfaced back to the human as a
          // hosted URL, so headless completion never depends on trusted UI.
          id: `${publicConfig.processorName}-stored-payment-method`,
          type: "stored_payment_method",
          processor: publicConfig.processorName,
          confirmation_experience: "off-session-token",
          requires_ap2_mandate: false,
          requires_trusted_ui: false,
          supports_challenge_handoff: true,
        },
      ],
      ap2: {
        mandate_verification: options.ap2Verifier ? "enabled" : "not-enabled",
        headless_completion_enabled: canHeadlessComplete,
      },
      stored_payment_method: {
        off_session_completion_enabled: true,
        setup_tools: ["payments.start-payment-method-setup", "payments.confirm-payment-method-setup"],
      },
    },
    evaluateCompleteRequest: async (body, checkout) => {
      const ap2 = readObject(body.ap2);
      const payment = readObject(body.payment);
      const paymentData = readObject(body.payment_data);

      // A stored-payment-method reference is an explicit instruction to charge a saved instrument
      // off-session. It stands on the buyer's setup-time consent, so it is recognized before the
      // AP2-mandate gate below.
      const savedCheckoutInstrumentId = readStoredPaymentMethodId(body);
      if (savedCheckoutInstrumentId) {
        return { kind: "headless-stored-payment-method", savedCheckoutInstrumentId };
      }

      if (!ap2 && !payment && !paymentData) {
        return null;
      }

      if (!ap2) {
        return {
          kind: "respond",
          response: createUcpEnvelope(
            "requires_action",
            {
              action: {
                type: "trusted_checkout_handoff",
                reason:
                  "Agent-provided payment instruments require AP2 checkout mandates before headless processor submission.",
              },
            },
            [
              {
                severity: "warning",
                code: "mandate_required",
                message: "AP2 checkout mandate is required for agentic payment-handler completion.",
              },
            ],
          ),
        };
      }

      const mandateShape = readAp2Mandates(ap2);
      if (mandateShape.kind === "invalid") {
        return { kind: "respond", response: mandateShape.response };
      }

      if (!options.ap2Verifier) {
        return {
          kind: "respond",
          response: createUcpEnvelope(
            "requires_action",
            {
              action: {
                type: "trusted_checkout_handoff",
                reason:
                  "AP2 checkout mandates are recognized but not accepted for headless completion until Payments owns a production mandate verification model.",
              },
            },
            [
              {
                severity: "warning",
                code: "mandate_verification_unavailable",
                message:
                  "Continue through trusted checkout UI; AP2 mandate verification is not enabled for headless money movement.",
              },
            ],
          ),
        };
      }

      const sharedPaymentToken = readSharedPaymentToken(body);
      if (!sharedPaymentToken || agenticHandlers.length === 0) {
        return {
          kind: "respond",
          response: createUcpEnvelope(
            "requires_action",
            {
              action: {
                type: "trusted_checkout_handoff",
                reason:
                  "Payment instruments from agents require trusted UI until a provider-backed payment handler is configured.",
              },
            },
            [
              {
                severity: "warning",
                code: "payment_handler_handoff_required",
                message: "Payment handler handoff is declared but headless processor submission is disabled.",
              },
            ],
          ),
        };
      }

      const verification = await options.ap2Verifier.verify({
        checkout,
        request: body,
        checkoutMandate: mandateShape.checkoutMandate,
        paymentMandate: mandateShape.paymentMandate,
        paymentToken: sharedPaymentToken,
        verifiedAt: new Date().toISOString(),
      });
      if (!verification.ok) {
        return {
          kind: "respond",
          response: createUcpEnvelope("error", {}, [
            {
              severity: "error",
              code: verification.code,
              message: verification.message,
            },
          ]),
        };
      }

      return {
        kind: "headless-agentic-payment",
        agenticPayment: {
          kind: "stripe-shared-payment-token",
          sharedPaymentGrantedToken: sharedPaymentToken,
          ap2CheckoutMandateId: mandateShape.checkoutMandate.id,
          ap2PaymentMandateId: mandateShape.paymentMandate?.id ?? null,
        },
        evidence: verification.evidence,
      };
    },
  };
}

function readAp2Mandates(ap2: Readonly<Record<string, unknown>>):
  | Readonly<{
      kind: "valid";
      checkoutMandate: UcpAp2MandateArtifact;
      paymentMandate: UcpAp2MandateArtifact | null;
    }>
  | Readonly<{ kind: "invalid"; response: UcpEnvelope }> {
  const checkoutMandate = readMandateArtifact(ap2.checkout_mandate);
  const paymentMandate = readMandateArtifact(ap2.payment_mandate);

  if (!checkoutMandate) {
    return {
      kind: "invalid",
      response: createUcpEnvelope("error", {}, [
        {
          severity: "error",
          code: "invalid_ap2_mandate",
          message: "AP2 completion requires checkout_mandate details.",
        },
      ]),
    };
  }

  return { kind: "valid", checkoutMandate, paymentMandate };
}

function readMandateArtifact(value: unknown): UcpAp2MandateArtifact | null {
  const stringValue = readString(value);
  if (stringValue) {
    return {
      id: readMandateId(stringValue),
      token: stringValue,
    };
  }

  const objectValue = readObject(value);
  if (!objectValue) {
    return null;
  }
  const token =
    readString(objectValue.token) ??
    readString(objectValue.sd_jwt) ??
    readString(objectValue.jwt) ??
    readString(objectValue.signature);
  if (!token) {
    return null;
  }
  return {
    id: readString(objectValue.id) ?? readMandateId(token),
    token,
  };
}

// A saved checkout instrument id (`sci_...`) from the hosted setup rail. Accepts the id from
// `payment_data`, a `payment.instruments[]` entry, or a top-level field so agents can supply it in
// whichever shape their connector emits. The `sci_` prefix disambiguates it from AP2 shared payment
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

function readSharedPaymentToken(body: Readonly<Record<string, unknown>>) {
  const paymentData = readObject(body.payment_data);
  if (readString(paymentData?.provider) === "stripe") {
    const token = readString(paymentData?.token) ?? readString(readObject(paymentData?.credential)?.token);
    if (token?.startsWith("spt_")) {
      return token;
    }
  }

  const payment = readObject(body.payment);
  const instruments = Array.isArray(payment?.instruments) ? payment?.instruments : [];
  for (const instrument of instruments) {
    const entry = readObject(instrument);
    const credential = readObject(entry?.credential);
    const token =
      readString(credential?.shared_payment_granted_token) ??
      readString(credential?.token) ??
      readString(entry?.shared_payment_granted_token);
    const provider = readString(entry?.provider) ?? readString(credential?.provider);
    if (token?.startsWith("spt_") && (!provider || provider === "stripe")) {
      return token;
    }
  }

  return null;
}

function readMandateId(token: string) {
  const hash = token.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
  return hash ? `ap2_${hash}` : null;
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
