import { describe, expect, it } from "vitest";
import {
  MARKETPLACE_CHECKOUT_FEE_EVIDENCE_VERSION,
  REQUIRED_CHECKOUT_FEE_PROOFS,
  REQUIRED_MARKETPLACE_CHECKOUT_FEE_POLICY_VERSION,
  buildCheckoutFeeEvidence,
  parseCheckoutFeeEvidenceArgs,
} from "./marketplace-checkout-fee-evidence.mjs";

function approval(overrides = {}) {
  return {
    approvalReference: "PAYMENTS-FEE-APPROVAL-2026-05-30",
    approvalCompletedAt: "2026-05-30T12:45:00.000Z",
    environment: "production",
    releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
    feePolicyVersion: REQUIRED_MARKETPLACE_CHECKOUT_FEE_POLICY_VERSION,
    feePolicyEffectiveAt: "2026-05-03T00:00:00.000Z",
    enabledJurisdictions: ["US"],
    basePercentageBps: 290,
    baseFixedAmount: "0.30",
    bankAccountResultingPercentageBps: 50,
    bankAccountResultingFixedAmount: "0.00",
    platformCreditResultingPercentageBps: 0,
    platformCreditResultingFixedAmount: "0.00",
    unsupportedMethodsDefault: "no-positive-fee",
    feeQuoteConfirmationRequired: true,
    feeQuoteStaleResponseCode: 409,
    feeQuoteStaleResponseError: "fee_quote_stale",
    stripeMode: "live",
    livePolicyEndpointUrl: "https://chasesets.com/api/marketplace/account/marketplace-checkout-fee-policy",
    livePolicyEndpointStatusCode: 200,
    livePolicyEndpointCheckedAt: "2026-05-30T13:15:00.000Z",
    livePolicyEndpointReference: "PAYMENTS-FEE-POLICY-ENDPOINT-2026-05-30",
    buyerFacingCopyReference: "PAYMENTS-FEE-COPY-2026-05-30",
    feeLabelsReference: "PAYMENTS-FEE-LABELS-2026-05-30",
    refundLanguageReference: "PAYMENTS-FEE-REFUNDS-2026-05-30",
    stateDisclosureReviewReference: "PAYMENTS-FEE-STATE-DISCLOSURES-2026-05-30",
    stripeLiveFeeConfigurationReference: "STRIPE-LIVE-FEE-CONFIG-2026-05-30",
    buyerFacingCopyApproved: true,
    feeLabelsApproved: true,
    refundLanguageApproved: true,
    stateDisclosureReviewApproved: true,
    stripeLiveFeeConfigurationApproved: true,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    approval: approval(),
    reference: "PAYMENTS-FEE-2026-05-30",
    owner: "Payments",
    checkedAt: "2026-05-30T13:30:00.000Z",
    ...overrides,
  };
}

describe("marketplace checkout fee evidence", () => {
  it("builds the launch packet gate from a complete production fee approval", () => {
    expect(buildCheckoutFeeEvidence(input())).toEqual({
      schemaVersion: MARKETPLACE_CHECKOUT_FEE_EVIDENCE_VERSION,
      approved: true,
      reference: "PAYMENTS-FEE-2026-05-30",
      owner: "Payments",
      checkedAt: "2026-05-30T13:30:00.000Z",
      approvalReference: "PAYMENTS-FEE-APPROVAL-2026-05-30",
      approvalCompletedAt: "2026-05-30T12:45:00.000Z",
      environment: "production",
      releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
      feePolicyVersion: REQUIRED_MARKETPLACE_CHECKOUT_FEE_POLICY_VERSION,
      feePolicyEffectiveAt: "2026-05-03T00:00:00.000Z",
      enabledJurisdictions: ["US"],
      basePercentageBps: 290,
      baseFixedAmount: "0.30",
      bankAccountResultingPercentageBps: 50,
      bankAccountResultingFixedAmount: "0.00",
      platformCreditResultingPercentageBps: 0,
      platformCreditResultingFixedAmount: "0.00",
      unsupportedMethodsDefault: "no-positive-fee",
      feeQuoteConfirmationRequired: true,
      feeQuoteStaleResponseCode: 409,
      feeQuoteStaleResponseError: "fee_quote_stale",
      stripeMode: "live",
      livePolicyEndpointUrl: "https://chasesets.com/api/marketplace/account/marketplace-checkout-fee-policy",
      livePolicyEndpointStatusCode: 200,
      livePolicyEndpointCheckedAt: "2026-05-30T13:15:00.000Z",
      livePolicyEndpointReference: "PAYMENTS-FEE-POLICY-ENDPOINT-2026-05-30",
      buyerFacingCopyReference: "PAYMENTS-FEE-COPY-2026-05-30",
      feeLabelsReference: "PAYMENTS-FEE-LABELS-2026-05-30",
      refundLanguageReference: "PAYMENTS-FEE-REFUNDS-2026-05-30",
      stateDisclosureReviewReference: "PAYMENTS-FEE-STATE-DISCLOSURES-2026-05-30",
      stripeLiveFeeConfigurationReference: "STRIPE-LIVE-FEE-CONFIG-2026-05-30",
      buyerFacingCopyApproved: true,
      feeLabelsApproved: true,
      refundLanguageApproved: true,
      stateDisclosureReviewApproved: true,
      stripeLiveFeeConfigurationApproved: true,
      passesCheckoutFeeGate: true,
    });
  });

  it("fails when required fee proof is not approved", () => {
    const evidence = buildCheckoutFeeEvidence(
      input({
        approval: approval({
          stateDisclosureReviewApproved: false,
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Marketplace Checkout Fee approval must prove stateDisclosureReviewApproved=true.",
    );
  });

  it("fails when approval is not production and Stripe live mode", () => {
    const evidence = buildCheckoutFeeEvidence(
      input({
        approval: approval({
          environment: "staging",
          stripeMode: "test",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Marketplace Checkout Fee approval must be production-scoped before marketplace launch.",
    );
    expect(evidence.errors).toContain("Marketplace Checkout Fee approval must use Stripe live mode.");
  });

  it("fails when the approved fee policy snapshot does not match the live Payments policy", () => {
    const evidence = buildCheckoutFeeEvidence(
      input({
        approval: approval({
          feePolicyVersion: "marketplace-checkout-fee/v1",
          feePolicyEffectiveAt: "not-a-date",
          enabledJurisdictions: ["US", "CA"],
          basePercentageBps: 300,
          baseFixedAmount: "0.35",
          bankAccountResultingPercentageBps: 75,
          bankAccountResultingFixedAmount: "0.05",
          platformCreditResultingPercentageBps: 10,
          platformCreditResultingFixedAmount: "0.01",
          unsupportedMethodsDefault: "card",
          feeQuoteConfirmationRequired: false,
          feeQuoteStaleResponseCode: 400,
          feeQuoteStaleResponseError: "stale",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      `Marketplace Checkout Fee approval must use feePolicyVersion=${REQUIRED_MARKETPLACE_CHECKOUT_FEE_POLICY_VERSION}.`,
    );
    expect(evidence.errors).toContain("Marketplace Checkout Fee feePolicyEffectiveAt must be an ISO timestamp.");
    expect(evidence.errors).toContain(
      "Marketplace Checkout Fee enabledJurisdictions must match the live policy endpoint: US.",
    );
    expect(evidence.errors).toContain(
      "Marketplace Checkout Fee base policy must match the live card policy: 290 bps plus 0.30.",
    );
    expect(evidence.errors).toContain(
      "Marketplace Checkout Fee bank-account policy must match the live policy: 50 bps plus 0.00.",
    );
    expect(evidence.errors).toContain(
      "Marketplace Checkout Fee platform-credit policy must match the live policy: 0 bps plus 0.00.",
    );
    expect(evidence.errors).toContain(
      "Marketplace Checkout Fee unsupportedMethodsDefault must match the live policy: no-positive-fee.",
    );
    expect(evidence.errors).toContain("Marketplace Checkout Fee feeQuoteConfirmationRequired must be true.");
    expect(evidence.errors).toContain(
      "Marketplace Checkout Fee stale quote response must match the live policy: 409 fee_quote_stale.",
    );
  });

  it("fails when the live policy endpoint observation is not production HTTP 200 evidence", () => {
    const evidence = buildCheckoutFeeEvidence(
      input({
        approval: approval({
          livePolicyEndpointUrl:
            "https://staging.chasesets.com/api/marketplace/account/marketplace-checkout-fee-policy",
          livePolicyEndpointStatusCode: 404,
          livePolicyEndpointCheckedAt: "2026-05-30T13:45:00.000Z",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Marketplace Checkout Fee livePolicyEndpointUrl must use /api/marketplace/account/marketplace-checkout-fee-policy on a production Chase Sets host.",
    );
    expect(evidence.errors).toContain("Marketplace Checkout Fee livePolicyEndpointStatusCode must be 200.");
    expect(evidence.errors).toContain(
      "Marketplace Checkout Fee livePolicyEndpointCheckedAt cannot be after checkedAt.",
    );
  });

  it("fails when releaseCommit is not a 40-character Git commit SHA", () => {
    const evidence = buildCheckoutFeeEvidence(
      input({
        approval: approval({
          releaseCommit: "launch-review",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Marketplace Checkout Fee releaseCommit must be a 40-character Git commit SHA.");
  });

  it("fails when fee approval is stale or after checkedAt", () => {
    const staleEvidence = buildCheckoutFeeEvidence(
      input({
        approval: approval({
          approvalCompletedAt: "2026-04-15T12:45:00.000Z",
        }),
      }),
    );
    const futureEvidence = buildCheckoutFeeEvidence(
      input({
        approval: approval({
          approvalCompletedAt: "2026-05-30T13:45:00.000Z",
        }),
      }),
    );

    expect(staleEvidence.approved).toBe(false);
    expect(staleEvidence.errors).toContain(
      "Marketplace Checkout Fee approvalCompletedAt cannot be older than 30 days.",
    );
    expect(futureEvidence.approved).toBe(false);
    expect(futureEvidence.errors).toContain("Marketplace Checkout Fee approvalCompletedAt cannot be after checkedAt.");
  });

  it("fails when fee approval timestamps are date-only values", () => {
    const evidence = buildCheckoutFeeEvidence(
      input({
        checkedAt: "2026-05-30",
        approval: approval({
          approvalCompletedAt: "2026-05-30",
          feePolicyEffectiveAt: "2026-05-30",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Marketplace Checkout Fee approvalCompletedAt must be an ISO timestamp.");
    expect(evidence.errors).toContain("Marketplace Checkout Fee feePolicyEffectiveAt must be an ISO timestamp.");
  });

  it("fails when the launch packet reference is missing", () => {
    const evidence = buildCheckoutFeeEvidence(input({ reference: "" }));

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Marketplace Checkout Fee evidence requires --reference or PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE.",
    );
  });

  it("fails when detailed approval references are placeholders", () => {
    const evidence = buildCheckoutFeeEvidence(
      input({
        approval: approval({
          buyerFacingCopyReference: "TBD",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Marketplace Checkout Fee buyerFacingCopyReference must point to a real external evidence record, not a placeholder.",
    );
  });

  it("keeps the required proof list aligned with the launch evidence verifier", () => {
    expect(REQUIRED_CHECKOUT_FEE_PROOFS).toEqual([
      "buyerFacingCopyApproved",
      "feeLabelsApproved",
      "refundLanguageApproved",
      "stateDisclosureReviewApproved",
      "stripeLiveFeeConfigurationApproved",
    ]);
  });

  it("parses operator arguments from flags and environment", () => {
    expect(
      parseCheckoutFeeEvidenceArgs(
        [
          "--approval",
          "secure/checkout-fee.json",
          "--reference",
          "PAYMENTS-FEE-2026-05-30",
          "--owner",
          "Payments Ops",
          "--checked-at",
          "2026-05-30T13:30:00.000Z",
        ],
        {},
      ),
    ).toMatchObject({
      approvalPath: "secure/checkout-fee.json",
      reference: "PAYMENTS-FEE-2026-05-30",
      owner: "Payments Ops",
      checkedAt: "2026-05-30T13:30:00.000Z",
    });

    expect(
      parseCheckoutFeeEvidenceArgs([], {
        MARKETPLACE_CHECKOUT_FEE_APPROVAL_RECORD: "secure/checkout-fee.json",
        PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE: "PAYMENTS-FEE-2026-05-30",
      }),
    ).toMatchObject({
      approvalPath: "secure/checkout-fee.json",
      reference: "PAYMENTS-FEE-2026-05-30",
      owner: "Payments",
    });
  });
});
