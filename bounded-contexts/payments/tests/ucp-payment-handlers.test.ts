import { describe, expect, it } from "vitest";
import { createPaymentsUcpHandoff } from "../support/ucp-support/payment-handlers";

describe("Payments UCP handoff", () => {
  const publicConfig = {
    processorName: "stripe",
    publishableKey: "pk_test_123",
    confirmationExperience: "processor-managed-form",
    dynamicPaymentMethods: true,
    sensitivePaymentDetailsHandledByProcessor: true,
  } as const;
  const handoff = createPaymentsUcpHandoff(publicConfig);

  it("declares only trusted and stored-payment-method completion", () => {
    const withSharedPaymentToken = createPaymentsUcpHandoff({
      ...publicConfig,
      agenticPaymentHandlers: [
        {
          id: "stripe-shared-payment-token",
          provider: "stripe",
          type: "shared_payment_token",
          confirmationExperience: "server-confirmed-payment-intent",
        },
      ],
    });

    expect(withSharedPaymentToken.payment).not.toHaveProperty("ap2");
    expect(withSharedPaymentToken.payment.handlers).toEqual([
      expect.objectContaining({ type: "processor_redirect_or_form", requires_trusted_ui: true }),
      expect.objectContaining({ type: "shared_payment_token", requires_trusted_ui: true }),
      expect.objectContaining({ type: "stored_payment_method", requires_trusted_ui: false }),
    ]);
    for (const handler of withSharedPaymentToken.payment.handlers) {
      expect(handler).not.toHaveProperty("requires_ap2_mandate");
    }

    // An agent-provided instrument without a stored-payment-method reference never reaches a
    // processor payment: Payments makes no completion decision and Checkout answers with its
    // trusted handoff.
    for (const body of [
      { ap2: { checkout_mandate: "checkout_mandate" }, payment_data: { provider: "stripe", token: "spt_123" } },
      {
        ap2: { checkout_mandate: "checkout_mandate" },
        payment: { instruments: [{ provider: "stripe", credential: { shared_payment_granted_token: "spt_123" } }] },
      },
    ]) {
      expect(withSharedPaymentToken.evaluateCompleteRequest(body)).toBeNull();
    }

    expect(
      withSharedPaymentToken.evaluateCompleteRequest({
        ap2: { checkout_mandate: "checkout_mandate" },
        payment_data: { provider: "stripe", token: "spt_123", saved_checkout_instrument_id: "sci_card_1" },
      }),
    ).toEqual({ kind: "headless-stored-payment-method", savedCheckoutInstrumentId: "sci_card_1" });
  });

  it("advertises the stored-payment-method off-session rail and setup tools", () => {
    expect(handoff.payment.stored_payment_method).toEqual({
      off_session_completion_enabled: true,
      setup_tools: ["payments.start-payment-method-setup", "payments.confirm-payment-method-setup"],
    });
    expect(handoff.payment.handlers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "stored_payment_method",
          requires_trusted_ui: false,
          supports_challenge_handoff: true,
        }),
      ]),
    );
  });

  it("selects the stored-payment-method rail from a saved instrument id", () => {
    const decision = handoff.evaluateCompleteRequest({
      payment_data: {
        provider: "stripe",
        saved_checkout_instrument_id: "sci_card_1",
      },
    });

    expect(decision).toEqual({
      kind: "headless-stored-payment-method",
      savedCheckoutInstrumentId: "sci_card_1",
    });
  });

  it("selects the stored-payment-method rail from a payment.instruments entry", () => {
    const decision = handoff.evaluateCompleteRequest({
      payment: {
        instruments: [{ type: "stored_payment_method", id: "sci_card_2" }],
      },
    });

    expect(decision).toEqual({
      kind: "headless-stored-payment-method",
      savedCheckoutInstrumentId: "sci_card_2",
    });
  });

  it("makes no completion decision for payment references that are not saved instrument ids", () => {
    const decision = handoff.evaluateCompleteRequest({
      payment: {
        instruments: [{ type: "stored_payment_method", id: "pm_not_an_instrument" }],
      },
    });

    expect(decision).toBeNull();
  });
});
