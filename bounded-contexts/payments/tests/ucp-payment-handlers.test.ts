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

  it("rejects AP2 completion attempts without structured mandate details", () => {
    const response = handoff.validateCompleteRequest({
      ap2: {
        checkout_mandate: "mandate_as_string",
      },
    });

    expect(response).toMatchObject({
      ucp: { status: "error" },
      messages: [{ code: "invalid_ap2_mandate" }],
    });
  });

  it("keeps structured AP2 mandates on trusted checkout handoff until mandate verification is enabled", () => {
    const response = handoff.validateCompleteRequest({
      ap2: {
        checkout_mandate: {
          id: "mandate_1",
          signature: "sig_1",
        },
      },
    });

    expect(response).toMatchObject({
      ucp: { status: "requires_action" },
      action: { type: "trusted_checkout_handoff" },
      messages: [{ code: "mandate_verification_unavailable" }],
    });
  });
});
