import { describe, expect, it } from "vitest";
import { createPaymentsUcpHandoff } from "../support/ucp-support/payment-handlers";

describe("Payments UCP handoff", () => {
  const handoff = createPaymentsUcpHandoff({
    processorName: "stripe",
    publishableKey: "pk_test_123",
    confirmationExperience: "processor-managed-form",
    dynamicPaymentMethods: true,
    sensitivePaymentDetailsHandledByProcessor: true,
  });

  const checkout = {
    id: "chk_1",
    status: "started",
    totals: [{ type: "total", amount: 1000 }],
  };

  it("rejects AP2 completion attempts without checkout mandate details", async () => {
    const decision = await handoff.evaluateCompleteRequest(
      {
        ap2: {
          payment_mandate: "payment_mandate",
        },
      },
      checkout,
    );

    expect(decision).toMatchObject({
      kind: "respond",
      response: {
        ucp: { status: "requires_action" },
        action: { type: "trusted_checkout_handoff" },
        messages: [{ code: "mandate_required" }],
      },
    });
  });

  it("keeps AP2 mandates on trusted checkout handoff until mandate verification is enabled", async () => {
    const decision = await handoff.evaluateCompleteRequest(
      {
        ap2: {
          checkout_mandate: "checkout_mandate",
        },
      },
      checkout,
    );

    expect(decision).toMatchObject({
      kind: "respond",
      response: {
        ucp: { status: "requires_action" },
        action: { type: "trusted_checkout_handoff" },
        messages: [{ code: "mandate_verification_unavailable" }],
      },
    });
  });

  it("accepts verified AP2 mandates with a Stripe shared payment token for headless handoff", async () => {
    const verifier = {
      verify: async () => ({
        ok: true as const,
        mode: "human-present" as const,
        evidence: { verifier: "test" },
      }),
    };
    const enabled = createPaymentsUcpHandoff(
      {
        processorName: "stripe",
        publishableKey: "pk_test_123",
        confirmationExperience: "processor-managed-form",
        dynamicPaymentMethods: true,
        sensitivePaymentDetailsHandledByProcessor: true,
        agenticPaymentHandlers: [
          {
            id: "stripe-shared-payment-token",
            provider: "stripe",
            type: "shared_payment_token",
            requiresAp2Mandate: true,
            confirmationExperience: "server-confirmed-payment-intent",
          },
        ],
      },
      { ap2Verifier: verifier, merchantAuthorizationEnabled: true },
    );

    const decision = await enabled.evaluateCompleteRequest(
      {
        ap2: {
          checkout_mandate: "checkout_mandate",
        },
        payment_data: {
          provider: "stripe",
          token: "spt_123",
        },
      },
      checkout,
    );

    expect(decision).toMatchObject({
      kind: "headless-agentic-payment",
      agenticPayment: {
        kind: "stripe-shared-payment-token",
        sharedPaymentGrantedToken: "spt_123",
      },
      evidence: { verifier: "test" },
    });
  });

  it.each(["mandate_invalid_signature", "mandate_expired"] as const)(
    "falls back to trusted checkout when verification returns %s",
    async (code) => {
      const enabled = createPaymentsUcpHandoff(
        {
          processorName: "stripe",
          publishableKey: "pk_test_123",
          confirmationExperience: "processor-managed-form",
          dynamicPaymentMethods: true,
          sensitivePaymentDetailsHandledByProcessor: true,
          agenticPaymentHandlers: [
            {
              id: "stripe-shared-payment-token",
              provider: "stripe",
              type: "shared_payment_token",
              requiresAp2Mandate: true,
              confirmationExperience: "server-confirmed-payment-intent",
            },
          ],
        },
        {
          merchantAuthorizationEnabled: true,
          ap2Verifier: {
            verify: async () => ({ ok: false as const, code, message: `Rejected ${code}.` }),
          },
        },
      );

      const decision = await enabled.evaluateCompleteRequest(
        {
          ap2: { checkout_mandate: "checkout_mandate" },
          payment_data: { provider: "stripe", token: "spt_123" },
        },
        checkout,
      );

      expect(decision).toMatchObject({
        kind: "respond",
        response: {
          ucp: { status: "requires_action" },
          action: { type: "trusted_checkout_handoff" },
          messages: [{ severity: "error", code }],
        },
      });
    },
  );

  it("keeps verified human-not-present mandates on trusted checkout", async () => {
    const enabled = createPaymentsUcpHandoff(
      {
        processorName: "stripe",
        publishableKey: "pk_test_123",
        confirmationExperience: "processor-managed-form",
        dynamicPaymentMethods: true,
        sensitivePaymentDetailsHandledByProcessor: true,
        agenticPaymentHandlers: [
          {
            id: "stripe-shared-payment-token",
            provider: "stripe",
            type: "shared_payment_token",
            requiresAp2Mandate: true,
            confirmationExperience: "server-confirmed-payment-intent",
          },
        ],
      },
      {
        merchantAuthorizationEnabled: true,
        ap2Verifier: {
          verify: async () => ({ ok: true as const, mode: "human-not-present" as const }),
        },
      },
    );

    const decision = await enabled.evaluateCompleteRequest(
      {
        ap2: { checkout_mandate: "checkout_mandate" },
        payment_data: { provider: "stripe", token: "spt_123" },
      },
      checkout,
    );

    expect(decision).toMatchObject({
      kind: "respond",
      response: {
        ucp: { status: "requires_action" },
        action: { type: "trusted_checkout_handoff" },
        messages: [{ code: "mandate_scope_mismatch" }],
      },
    });
  });

  it("does not advertise headless completion without merchant authorization signing", () => {
    const verifierOnly = createPaymentsUcpHandoff(
      {
        processorName: "stripe",
        publishableKey: "pk_test_123",
        confirmationExperience: "processor-managed-form",
        dynamicPaymentMethods: true,
        sensitivePaymentDetailsHandledByProcessor: true,
        agenticPaymentHandlers: [
          {
            id: "stripe-shared-payment-token",
            provider: "stripe",
            type: "shared_payment_token",
            requiresAp2Mandate: true,
            confirmationExperience: "server-confirmed-payment-intent",
          },
        ],
      },
      {
        ap2Verifier: { verify: async () => ({ ok: true as const, mode: "human-present" as const }) },
      },
    );

    expect(verifierOnly.payment.ap2).toMatchObject({
      merchant_authorization: "not-enabled",
      shared_payment_token: "enabled",
      headless_completion_enabled: false,
      supported_modes: ["human-present"],
    });
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
          requires_ap2_mandate: false,
          requires_trusted_ui: false,
          supports_challenge_handoff: true,
        }),
      ]),
    );
  });

  it("selects the stored-payment-method rail from a saved instrument id without an AP2 mandate", async () => {
    const decision = await handoff.evaluateCompleteRequest(
      {
        payment_data: {
          provider: "stripe",
          saved_checkout_instrument_id: "sci_card_1",
        },
      },
      checkout,
    );

    expect(decision).toEqual({
      kind: "headless-stored-payment-method",
      savedCheckoutInstrumentId: "sci_card_1",
    });
  });

  it("selects the stored-payment-method rail from a payment.instruments entry", async () => {
    const decision = await handoff.evaluateCompleteRequest(
      {
        payment: {
          instruments: [{ type: "stored_payment_method", id: "sci_card_2" }],
        },
      },
      checkout,
    );

    expect(decision).toEqual({
      kind: "headless-stored-payment-method",
      savedCheckoutInstrumentId: "sci_card_2",
    });
  });

  it("ignores non-stored-instrument payment references that are not saved instrument ids", async () => {
    const decision = await handoff.evaluateCompleteRequest(
      {
        payment: {
          instruments: [{ type: "stored_payment_method", id: "pm_not_an_instrument" }],
        },
      },
      checkout,
    );

    // No AP2 mandate and no saved instrument id: falls through to the trusted-UI handoff.
    expect(decision).toMatchObject({
      kind: "respond",
      response: { ucp: { status: "requires_action" } },
    });
  });
});
