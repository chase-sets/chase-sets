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
        ucp: { status: "error" },
        messages: [{ code: "invalid_ap2_mandate" }],
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
      { ap2Verifier: verifier },
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
});
