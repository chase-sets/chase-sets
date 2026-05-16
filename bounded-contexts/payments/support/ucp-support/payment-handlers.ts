import { createUcpEnvelope, type UcpEnvelope } from "@chase-sets/ucp";
import type { PaymentProcessorPublicConfig } from "@chase-sets/payment-processing";

export type UcpPaymentHandlerHandoff = Readonly<{
  payment: Readonly<{
    handlers: readonly Readonly<Record<string, unknown>>[];
    ap2: Readonly<{
      mandate_verification: "not-enabled";
      headless_completion_enabled: false;
    }>;
  }>;
  validateCompleteRequest: (
    body: Readonly<Record<string, unknown>>,
  ) => UcpEnvelope | null;
}>;

export function createPaymentsUcpHandoff(
  publicConfig: PaymentProcessorPublicConfig,
): UcpPaymentHandlerHandoff {
  return {
    payment: {
      handlers: [
        {
          id: `${publicConfig.processorName}-trusted-checkout`,
          type: "processor_redirect_or_form",
          processor: publicConfig.processorName,
          confirmation_experience: publicConfig.confirmationExperience,
          dynamic_payment_methods: publicConfig.dynamicPaymentMethods,
          sensitive_payment_details_handled_by_processor:
            publicConfig.sensitivePaymentDetailsHandledByProcessor,
          requires_trusted_ui: true,
        },
      ],
      ap2: {
        mandate_verification: "not-enabled",
        headless_completion_enabled: false,
      },
    },
    validateCompleteRequest: (body) => {
      const ap2 = readObject(body.ap2);
      const payment = readObject(body.payment);
      if (!ap2 && !payment) {
        return null;
      }

      if (ap2) {
        const mandateValidation = validateAp2MandateShape(ap2);
        if (mandateValidation) {
          return mandateValidation;
        }

        return createUcpEnvelope("requires_action", {
          action: {
            type: "trusted_checkout_handoff",
            reason: "AP2 checkout mandates are recognized but not accepted for headless completion until Payments owns a production mandate verification model.",
          },
        }, [
          {
            severity: "warning",
            code: "mandate_verification_unavailable",
            message: "Continue through trusted checkout UI; AP2 mandate verification is not enabled for headless money movement.",
          },
        ]);
      }

      const instruments = Array.isArray(payment?.instruments)
        ? payment?.instruments
        : [];
      if (instruments.length > 0) {
        return createUcpEnvelope("requires_action", {
          action: {
            type: "trusted_checkout_handoff",
            reason: "Payment instruments from agents require trusted UI until a Payments-owned payment-handler handoff is production verified.",
          },
        }, [
          {
            severity: "warning",
            code: "payment_handler_handoff_required",
            message: "Payment handler handoff is declared but headless processor submission is disabled.",
          },
        ]);
      }

      return null;
    },
  };
}

function validateAp2MandateShape(ap2: Readonly<Record<string, unknown>>) {
  const checkoutMandate = readObject(ap2.checkout_mandate);
  const paymentMandate = readObject(ap2.payment_mandate);
  const mandate = checkoutMandate ?? paymentMandate;

  if (!mandate) {
    return createUcpEnvelope("error", {}, [
      {
        severity: "error",
        code: "invalid_ap2_mandate",
        message: "AP2 completion requires structured checkout_mandate or payment_mandate details.",
      },
    ]);
  }

  if (!readString(mandate.id) || !readString(mandate.signature)) {
    return createUcpEnvelope("error", {}, [
      {
        severity: "error",
        code: "invalid_ap2_mandate",
        message: "AP2 mandates must include an id and signature before Payments can evaluate autonomous completion.",
      },
    ]);
  }

  return null;
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
