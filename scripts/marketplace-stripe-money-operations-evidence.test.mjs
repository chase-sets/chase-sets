import { describe, expect, it } from "vitest";
import webhookEventRegistry from "../infrastructure/stripe-config/webhook-events.json" with { type: "json" };
import {
  MARKETPLACE_STRIPE_MONEY_OPERATIONS_EVIDENCE_VERSION,
  REQUIRED_STRIPE_MONEY_OPERATION_EVENT_ID_GROUPS,
  REQUIRED_STRIPE_MONEY_OPERATION_IDENTIFIERS,
  REQUIRED_STRIPE_MONEY_OPERATION_REFERENCES,
  REQUIRED_STRIPE_MONEY_OPERATION_PROOFS,
  buildStripeMoneyOperationsEvidence,
  parseStripeMoneyOperationsEvidenceArgs,
} from "./marketplace-stripe-money-operations-evidence.mjs";

function proof(overrides = {}) {
  return {
    proofReference: "STRIPE-MONEY-PROOF-2026-05-30",
    proofCompletedAt: "2026-05-30T12:30:00.000Z",
    environment: "live",
    releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
    apiVersion: webhookEventRegistry.apiVersion,
    paymentWebhookDestination: "https://marketplace.chasesets.com/api/payments/provider/webhooks",
    connectWebhookDestination: "https://marketplace.chasesets.com/api/settlement/provider/money-movement/webhooks",
    connectAccountsApi: "v1",
    connectCustomAccountProofCompletedAt: "2026-05-30T12:25:00.000Z",
    connectPayoutSetupPageUrl: "https://marketplace.chasesets.com/account/payouts/setup",
    connectPayoutSetupPageEvidenceKind: "screenshot",
    connectDashboardAccess: "none",
    connectControllerFeesPayer: "application",
    connectControllerLossesCollector: "application",
    connectControllerRequirementCollection: "application",
    connectConnectedAccountCount: 1,
    connectCustomDashboardNoneAccountCount: 1,
    connectEmbeddedSetupSessionCount: 2,
    connectReleaseHardeningOpenP0P2FindingCount: 0,
    sensitiveProviderDataStoredCount: 0,
    paymentProviderEventRowCount: 5,
    connectProviderEventRowCount: 2,
    livePaymentIntentId: "pi_liveCheckout20260530",
    liveCheckoutSessionId: "cs_liveCheckout20260530",
    refundId: "re_liveRefund20260530",
    disputeId: "dp_liveDispute20260530",
    connectAccountId: "acct_liveSeller20260530",
    payoutReadinessAccountId: "acct_liveSeller20260530",
    payoutFailurePayoutId: "po_liveFailure20260530",
    payoutFailureBalanceTransactionId: "txn_payoutFailure20260530",
    platformFundingBalanceTransactionId: "txn_platformFunding20260530",
    paymentProviderEventIds: [
      "evt_paymentCheckout2026053001",
      "evt_paymentIntent2026053002",
      "evt_paymentRefund2026053003",
      "evt_paymentDispute2026053004",
      "evt_paymentWebhookReplay2026053005",
    ],
    connectProviderEventIds: ["evt_connectAccount2026053001", "evt_connectPayout2026053002"],
    liveCheckoutReference: "STRIPE-LIVE-CHECKOUT-2026-05-30",
    refundReference: "STRIPE-REFUND-2026-05-30",
    disputeReference: "STRIPE-DISPUTE-2026-05-30",
    connectCustomAccountProofReference: "STRIPE-CONNECT-CUSTOM-ACCOUNT-2026-05-30",
    connectEmbeddedSetupSessionReference: "STRIPE-CONNECT-EMBEDDED-SETUP-2026-05-30",
    connectPayoutSetupPageReference: "STRIPE-CONNECT-PAYOUT-SETUP-PAGE-2026-05-30",
    connectFreshSetupSessionsReference: "STRIPE-CONNECT-FRESH-SESSIONS-2026-05-30",
    connectProviderReadinessRefreshReference: "STRIPE-CONNECT-READINESS-REFRESH-2026-05-30",
    connectAccountWebhookRowsReference: "STRIPE-CONNECT-WEBHOOK-ROWS-2026-05-30",
    connectSensitiveDataReviewReference: "STRIPE-CONNECT-SENSITIVE-DATA-REVIEW-2026-05-30",
    connectReleaseHardeningReference: "STRIPE-CONNECT-RELEASE-HARDENING-2026-05-30",
    stagingCustomConnectSandboxSmokeReference: "STRIPE-CONNECT-STAGING-SANDBOX-SMOKE-2026-05-30",
    connectRollbackRehearsalReference: "STRIPE-CONNECT-ROLLBACK-REHEARSAL-2026-05-30",
    payoutReadinessReference: "STRIPE-PAYOUT-READINESS-2026-05-30",
    payoutPreviewAndRequestReference: "STRIPE-PAYOUT-PREVIEW-REQUEST-2026-05-30",
    transferAndConnectedAccountPayoutReference: "STRIPE-TRANSFER-PAYOUT-2026-05-30",
    payoutFailureReversalReference: "STRIPE-PAYOUT-FAILURE-REVERSAL-2026-05-30",
    reconciliationReference: "STRIPE-RECONCILIATION-2026-05-30",
    platformBalanceFundingReference: "STRIPE-PLATFORM-BALANCE-2026-05-30",
    webhookReplayReference: "STRIPE-WEBHOOK-REPLAY-2026-05-30",
    paymentProviderEventQueryReference: "PAYMENTS-PROVIDER-WEBHOOK-EVENTS-2026-05-30",
    connectProviderEventQueryReference: "SETTLEMENT-MONEY-MOVEMENT-WEBHOOK-EVENTS-2026-05-30",
    radarRiskPostureReference: "STRIPE-RADAR-RISK-2026-05-30",
    liveCheckoutProven: true,
    refundProven: true,
    disputeProven: true,
    connectDashboardNoneConfigured: true,
    connectEmbeddedSetupSessionCreated: true,
    connectPayoutSetupPageProven: true,
    connectFreshSetupSessionsProven: true,
    connectProviderReadinessRefreshProven: true,
    connectAccountWebhookRowsProven: true,
    connectNoSensitiveProviderDataStored: true,
    connectCustomAccountProofProven: true,
    connectReleaseHardeningFindingsResolved: true,
    stagingCustomConnectSandboxSmokeProven: true,
    connectRollbackRehearsalProven: true,
    payoutReadinessProven: true,
    payoutPreviewAndRequestProven: true,
    transferAndConnectedAccountPayoutProven: true,
    payoutFailureReversalProven: true,
    reconciliationProven: true,
    platformBalanceFundingProven: true,
    webhookReplayProven: true,
    radarRiskPostureApproved: true,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    proof: proof(),
    reference: "STRIPE-MONEY-2026-05-30",
    owner: "Payments and Settlement",
    checkedAt: "2026-05-30T13:00:00.000Z",
    ...overrides,
  };
}

describe("marketplace stripe money operations evidence", () => {
  it("builds the approval gate from complete live Stripe proof", () => {
    expect(buildStripeMoneyOperationsEvidence(input())).toEqual({
      schemaVersion: MARKETPLACE_STRIPE_MONEY_OPERATIONS_EVIDENCE_VERSION,
      approved: true,
      reference: "STRIPE-MONEY-2026-05-30",
      owner: "Payments and Settlement",
      checkedAt: "2026-05-30T13:00:00.000Z",
      proofReference: "STRIPE-MONEY-PROOF-2026-05-30",
      proofCompletedAt: "2026-05-30T12:30:00.000Z",
      environment: "live",
      releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
      apiVersion: webhookEventRegistry.apiVersion,
      paymentWebhookDestination: "https://marketplace.chasesets.com/api/payments/provider/webhooks",
      connectWebhookDestination: "https://marketplace.chasesets.com/api/settlement/provider/money-movement/webhooks",
      connectAccountsApi: "v1",
      connectCustomAccountProofCompletedAt: "2026-05-30T12:25:00.000Z",
      connectPayoutSetupPageUrl: "https://marketplace.chasesets.com/account/payouts/setup",
      connectPayoutSetupPageEvidenceKind: "screenshot",
      connectDashboardAccess: "none",
      connectControllerFeesPayer: "application",
      connectControllerLossesCollector: "application",
      connectControllerRequirementCollection: "application",
      connectConnectedAccountCount: 1,
      connectCustomDashboardNoneAccountCount: 1,
      connectEmbeddedSetupSessionCount: 2,
      connectReleaseHardeningOpenP0P2FindingCount: 0,
      sensitiveProviderDataStoredCount: 0,
      paymentProviderEventRowCount: 5,
      connectProviderEventRowCount: 2,
      livePaymentIntentId: "pi_liveCheckout20260530",
      liveCheckoutSessionId: "cs_liveCheckout20260530",
      refundId: "re_liveRefund20260530",
      disputeId: "dp_liveDispute20260530",
      connectAccountId: "acct_liveSeller20260530",
      payoutReadinessAccountId: "acct_liveSeller20260530",
      payoutFailurePayoutId: "po_liveFailure20260530",
      payoutFailureBalanceTransactionId: "txn_payoutFailure20260530",
      platformFundingBalanceTransactionId: "txn_platformFunding20260530",
      paymentProviderEventIds: [
        "evt_paymentCheckout2026053001",
        "evt_paymentIntent2026053002",
        "evt_paymentRefund2026053003",
        "evt_paymentDispute2026053004",
        "evt_paymentWebhookReplay2026053005",
      ],
      connectProviderEventIds: ["evt_connectAccount2026053001", "evt_connectPayout2026053002"],
      liveCheckoutReference: "STRIPE-LIVE-CHECKOUT-2026-05-30",
      refundReference: "STRIPE-REFUND-2026-05-30",
      disputeReference: "STRIPE-DISPUTE-2026-05-30",
      connectCustomAccountProofReference: "STRIPE-CONNECT-CUSTOM-ACCOUNT-2026-05-30",
      connectEmbeddedSetupSessionReference: "STRIPE-CONNECT-EMBEDDED-SETUP-2026-05-30",
      connectPayoutSetupPageReference: "STRIPE-CONNECT-PAYOUT-SETUP-PAGE-2026-05-30",
      connectFreshSetupSessionsReference: "STRIPE-CONNECT-FRESH-SESSIONS-2026-05-30",
      connectProviderReadinessRefreshReference: "STRIPE-CONNECT-READINESS-REFRESH-2026-05-30",
      connectAccountWebhookRowsReference: "STRIPE-CONNECT-WEBHOOK-ROWS-2026-05-30",
      connectSensitiveDataReviewReference: "STRIPE-CONNECT-SENSITIVE-DATA-REVIEW-2026-05-30",
      connectReleaseHardeningReference: "STRIPE-CONNECT-RELEASE-HARDENING-2026-05-30",
      stagingCustomConnectSandboxSmokeReference: "STRIPE-CONNECT-STAGING-SANDBOX-SMOKE-2026-05-30",
      connectRollbackRehearsalReference: "STRIPE-CONNECT-ROLLBACK-REHEARSAL-2026-05-30",
      payoutReadinessReference: "STRIPE-PAYOUT-READINESS-2026-05-30",
      payoutPreviewAndRequestReference: "STRIPE-PAYOUT-PREVIEW-REQUEST-2026-05-30",
      transferAndConnectedAccountPayoutReference: "STRIPE-TRANSFER-PAYOUT-2026-05-30",
      payoutFailureReversalReference: "STRIPE-PAYOUT-FAILURE-REVERSAL-2026-05-30",
      reconciliationReference: "STRIPE-RECONCILIATION-2026-05-30",
      platformBalanceFundingReference: "STRIPE-PLATFORM-BALANCE-2026-05-30",
      webhookReplayReference: "STRIPE-WEBHOOK-REPLAY-2026-05-30",
      paymentProviderEventQueryReference: "PAYMENTS-PROVIDER-WEBHOOK-EVENTS-2026-05-30",
      connectProviderEventQueryReference: "SETTLEMENT-MONEY-MOVEMENT-WEBHOOK-EVENTS-2026-05-30",
      radarRiskPostureReference: "STRIPE-RADAR-RISK-2026-05-30",
      liveCheckoutProven: true,
      refundProven: true,
      disputeProven: true,
      connectDashboardNoneConfigured: true,
      connectEmbeddedSetupSessionCreated: true,
      connectPayoutSetupPageProven: true,
      connectFreshSetupSessionsProven: true,
      connectProviderReadinessRefreshProven: true,
      connectAccountWebhookRowsProven: true,
      connectNoSensitiveProviderDataStored: true,
      connectCustomAccountProofProven: true,
      connectReleaseHardeningFindingsResolved: true,
      stagingCustomConnectSandboxSmokeProven: true,
      connectRollbackRehearsalProven: true,
      payoutReadinessProven: true,
      payoutPreviewAndRequestProven: true,
      transferAndConnectedAccountPayoutProven: true,
      payoutFailureReversalProven: true,
      reconciliationProven: true,
      platformBalanceFundingProven: true,
      webhookReplayProven: true,
      radarRiskPostureApproved: true,
      passesStripeMoneyOperationsGate: true,
    });
  });

  it("accepts an Accounts v2 proof when the same dashboard-none application-owned posture is proven", () => {
    const evidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          connectAccountsApi: "v2",
        }),
      }),
    );

    expect(evidence.approved).toBe(true);
    expect(evidence.connectAccountsApi).toBe("v2");
    expect(evidence.connectDashboardAccess).toBe("none");
    expect(evidence.connectControllerFeesPayer).toBe("application");
    expect(evidence.connectControllerLossesCollector).toBe("application");
    expect(evidence.connectControllerRequirementCollection).toBe("application");
  });

  it("fails when any required Stripe proof is missing", () => {
    const evidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          payoutFailureReversalProven: false,
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Stripe money operations proof must prove payoutFailureReversalProven=true.");
  });

  it("fails when proof is not live mode and has no connected account", () => {
    const evidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          environment: "test",
          connectConnectedAccountCount: 0,
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Stripe money operations proof must use Stripe live mode.");
    expect(evidence.errors).toContain(
      "Stripe money operations proof must include at least one live connected account.",
    );
  });

  it("fails when the selected Connect Accounts API posture is unsupported", () => {
    const evidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          connectAccountsApi: "express",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Stripe money operations proof must set connectAccountsApi to v1 or v2.");
  });

  it("fails when custom account proof is incomplete or stores sensitive provider data", () => {
    const evidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          connectCustomDashboardNoneAccountCount: 0,
          connectEmbeddedSetupSessionCount: 1,
          sensitiveProviderDataStoredCount: 1,
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Stripe money operations proof must include at least one live dashboard-none connected account.",
    );
    expect(evidence.errors).toContain(
      "Stripe money operations proof must include at least two fresh embedded setup sessions.",
    );
    expect(evidence.errors).toContain(
      "Stripe money operations proof must not store raw sensitive provider data in Chase Sets.",
    );
  });

  it("fails when custom Connect release hardening or rollback rehearsal is incomplete", () => {
    const evidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          connectReleaseHardeningOpenP0P2FindingCount: 1,
          connectReleaseHardeningFindingsResolved: false,
          stagingCustomConnectSandboxSmokeProven: false,
          connectRollbackRehearsalProven: false,
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Stripe money operations proof must resolve all P0-P2 custom Connect hardening findings.",
    );
    expect(evidence.errors).toContain(
      "Stripe money operations proof must prove connectReleaseHardeningFindingsResolved=true.",
    );
    expect(evidence.errors).toContain(
      "Stripe money operations proof must prove stagingCustomConnectSandboxSmokeProven=true.",
    );
    expect(evidence.errors).toContain("Stripe money operations proof must prove connectRollbackRehearsalProven=true.");
  });

  it("fails when embedded Custom Connect setup proof is missing or stale", () => {
    const evidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          connectEmbeddedSetupSessionCreated: false,
          connectPayoutSetupPageEvidenceKind: "hosted-dashboard",
          connectCustomAccountProofCompletedAt: "2026-04-15T12:30:00.000Z",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Stripe money operations proof must prove connectEmbeddedSetupSessionCreated=true.",
    );
    expect(evidence.errors).toContain(
      "Stripe money operations proof must include connectPayoutSetupPageEvidenceKind of screenshot or redacted-run-output.",
    );
    expect(evidence.errors).toContain(
      "Stripe money operations connectCustomAccountProofCompletedAt cannot be older than 30 days.",
    );
  });

  it("fails when Custom Connect account controller proof uses hosted dashboard posture", () => {
    const evidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          connectDashboardAccess: "express",
          connectControllerFeesPayer: "account",
          connectControllerLossesCollector: "stripe",
          connectControllerRequirementCollection: "stripe",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Stripe money operations proof must configure dashboard access as none for Custom accounts.",
    );
    expect(evidence.errors).toContain(
      "Stripe money operations proof must configure Connect fees payer as application.",
    );
    expect(evidence.errors).toContain(
      "Stripe money operations proof must configure Connect losses collector as application.",
    );
    expect(evidence.errors).toContain(
      "Stripe money operations proof must configure Connect requirement collection as application.",
    );
  });

  it("fails when provider webhook event row counts do not prove Payments and Settlement ingestion", () => {
    const evidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          paymentProviderEventRowCount: 4,
          connectProviderEventRowCount: 1,
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Stripe money operations proof must include at least five Payments provider webhook event rows.",
    );
    expect(evidence.errors).toContain(
      "Stripe money operations proof must include at least two Settlement money-movement provider webhook event rows.",
    );
  });

  it("fails when live Stripe object identifiers are placeholders or use the wrong object type", () => {
    const evidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          livePaymentIntentId: "sample",
          refundId: "pi_liveRefund20260530",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Stripe money operations livePaymentIntentId must be a concrete Stripe identifier starting with pi_.",
    );
    expect(evidence.errors).toContain(
      "Stripe money operations refundId must be a concrete Stripe identifier starting with re_.",
    );
  });

  it("fails when provider webhook event ids are missing, placeholders, or duplicated", () => {
    const evidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          paymentProviderEventIds: [
            "evt_paymentCheckout2026053001",
            "evt_paymentCheckout2026053001",
            "evt_paymentRefund2026053003",
            "evt_sample",
          ],
          connectProviderEventIds: ["evt_connectAccount2026053001"],
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Stripe money operations paymentProviderEventIds must include at least 5 concrete Stripe event IDs.",
    );
    expect(evidence.errors).toContain(
      "Stripe money operations paymentProviderEventIds must not contain duplicate Stripe event IDs.",
    );
    expect(evidence.errors).toContain(
      "Stripe money operations paymentProviderEventIds entries must be concrete Stripe identifiers starting with evt_.",
    );
    expect(evidence.errors).toContain(
      "Stripe money operations connectProviderEventIds must include at least 2 concrete Stripe event IDs.",
    );
  });

  it("fails when proof reference is a placeholder", () => {
    const evidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          proofReference: "sample",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Stripe money operations proofReference must point to a real external evidence record, not a placeholder.",
    );
  });

  it("fails when a workflow reference is a placeholder", () => {
    const evidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          refundReference: "ticket",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Stripe money operations refundReference must point to a real external evidence record, not a placeholder.",
    );
  });

  it("fails when releaseCommit is not a 40-character Git commit SHA", () => {
    const evidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          releaseCommit: "stripe-live-proof",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Stripe money operations releaseCommit must be a 40-character Git commit SHA.");
  });

  it("fails when live Stripe proof is stale or after checkedAt", () => {
    const staleEvidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          proofCompletedAt: "2026-04-15T12:30:00.000Z",
        }),
      }),
    );
    const futureEvidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          proofCompletedAt: "2026-05-30T13:05:00.000Z",
        }),
      }),
    );

    expect(staleEvidence.approved).toBe(false);
    expect(staleEvidence.errors).toContain("Stripe money operations proofCompletedAt cannot be older than 30 days.");
    expect(futureEvidence.approved).toBe(false);
    expect(futureEvidence.errors).toContain("Stripe money operations proofCompletedAt cannot be after checkedAt.");
  });

  it("fails when live Stripe proof timestamps are date-only values", () => {
    const proofCompletedOnly = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          proofCompletedAt: "2026-05-30",
        }),
      }),
    );
    const checkedOnly = buildStripeMoneyOperationsEvidence(input({ checkedAt: "2026-05-30" }));

    expect(proofCompletedOnly.approved).toBe(false);
    expect(proofCompletedOnly.errors).toContain("Stripe money operations proofCompletedAt must be an ISO timestamp.");
    expect(checkedOnly.approved).toBe(false);
    expect(checkedOnly.errors).toContain("Stripe money operations evidence checkedAt must be an ISO timestamp.");
  });

  it("accepts private proof-mode Stripe callback hosts and embedded setup page hosts", () => {
    const rootEvidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          paymentWebhookDestination: "https://chasesets.com/api/payments/provider/webhooks",
          connectWebhookDestination: "https://chasesets.com/api/settlement/provider/money-movement/webhooks",
          connectPayoutSetupPageUrl: "https://chasesets.com/account/payouts/setup",
        }),
      }),
    );
    const adminEvidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          paymentWebhookDestination: "https://admin.chasesets.com/api/payments/provider/webhooks",
          connectWebhookDestination: "https://admin.chasesets.com/api/settlement/provider/money-movement/webhooks",
          connectPayoutSetupPageUrl: "https://admin.chasesets.com/account/payouts/setup",
        }),
      }),
    );

    expect(rootEvidence.approved).toBe(true);
    expect(adminEvidence.approved).toBe(true);
  });

  it("fails when the webhook destination is not a production Chase Sets provider callback", () => {
    const evidence = buildStripeMoneyOperationsEvidence(
      input({
        proof: proof({
          paymentWebhookDestination: "https://staging.chasesets.com/api/payments/provider/webhooks",
          connectWebhookDestination: "https://marketplace.chasesets.com/api/payments/provider/webhooks",
          connectPayoutSetupPageUrl: "https://marketplace.chasesets.com/checkout",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Stripe money operations proof must use the production Chase Sets payment provider webhook destination.",
    );
    expect(evidence.errors).toContain(
      "Stripe money operations proof must use the production Chase Sets Connect money-movement webhook destination.",
    );
    expect(evidence.errors).toContain(
      "Stripe money operations proof must use the production Chase Sets embedded payout setup page.",
    );
  });

  it("keeps the required proof list aligned with the launch evidence verifier", () => {
    expect(REQUIRED_STRIPE_MONEY_OPERATION_PROOFS).toEqual([
      "liveCheckoutProven",
      "refundProven",
      "disputeProven",
      "connectDashboardNoneConfigured",
      "connectEmbeddedSetupSessionCreated",
      "connectPayoutSetupPageProven",
      "connectFreshSetupSessionsProven",
      "connectProviderReadinessRefreshProven",
      "connectAccountWebhookRowsProven",
      "connectNoSensitiveProviderDataStored",
      "connectCustomAccountProofProven",
      "connectReleaseHardeningFindingsResolved",
      "stagingCustomConnectSandboxSmokeProven",
      "connectRollbackRehearsalProven",
      "payoutReadinessProven",
      "payoutPreviewAndRequestProven",
      "transferAndConnectedAccountPayoutProven",
      "payoutFailureReversalProven",
      "reconciliationProven",
      "platformBalanceFundingProven",
      "webhookReplayProven",
      "radarRiskPostureApproved",
    ]);
    expect(REQUIRED_STRIPE_MONEY_OPERATION_REFERENCES).toEqual([
      "liveCheckoutReference",
      "refundReference",
      "disputeReference",
      "connectCustomAccountProofReference",
      "connectEmbeddedSetupSessionReference",
      "connectPayoutSetupPageReference",
      "connectFreshSetupSessionsReference",
      "connectProviderReadinessRefreshReference",
      "connectAccountWebhookRowsReference",
      "connectSensitiveDataReviewReference",
      "connectReleaseHardeningReference",
      "stagingCustomConnectSandboxSmokeReference",
      "connectRollbackRehearsalReference",
      "payoutReadinessReference",
      "payoutPreviewAndRequestReference",
      "transferAndConnectedAccountPayoutReference",
      "payoutFailureReversalReference",
      "reconciliationReference",
      "platformBalanceFundingReference",
      "webhookReplayReference",
      "paymentProviderEventQueryReference",
      "connectProviderEventQueryReference",
      "radarRiskPostureReference",
    ]);
    expect(REQUIRED_STRIPE_MONEY_OPERATION_IDENTIFIERS).toEqual([
      { key: "livePaymentIntentId", prefix: "pi_" },
      { key: "liveCheckoutSessionId", prefix: "cs_" },
      { key: "refundId", prefix: "re_" },
      { key: "disputeId", prefix: "dp_" },
      { key: "connectAccountId", prefix: "acct_" },
      { key: "payoutReadinessAccountId", prefix: "acct_" },
      { key: "payoutFailurePayoutId", prefix: "po_" },
      { key: "payoutFailureBalanceTransactionId", prefix: "txn_" },
      { key: "platformFundingBalanceTransactionId", prefix: "txn_" },
    ]);
    expect(REQUIRED_STRIPE_MONEY_OPERATION_EVENT_ID_GROUPS).toEqual([
      { key: "paymentProviderEventIds", prefix: "evt_", minimumCount: 5 },
      { key: "connectProviderEventIds", prefix: "evt_", minimumCount: 2 },
    ]);
  });

  it("parses operator arguments from flags and environment", () => {
    expect(
      parseStripeMoneyOperationsEvidenceArgs(
        [
          "--proof",
          "secure/stripe-money.json",
          "--reference",
          "STRIPE-MONEY-2026-05-30",
          "--owner",
          "Finance Ops",
          "--checked-at",
          "2026-05-30T13:00:00.000Z",
        ],
        {},
      ),
    ).toMatchObject({
      proofPath: "secure/stripe-money.json",
      reference: "STRIPE-MONEY-2026-05-30",
      owner: "Finance Ops",
      checkedAt: "2026-05-30T13:00:00.000Z",
    });

    expect(
      parseStripeMoneyOperationsEvidenceArgs([], {
        STRIPE_MONEY_OPERATIONS_PROOF_RECORD: "secure/stripe-money.json",
        PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE: "STRIPE-MONEY-2026-05-30",
      }),
    ).toMatchObject({
      proofPath: "secure/stripe-money.json",
      reference: "STRIPE-MONEY-2026-05-30",
      owner: "Payments and Settlement",
    });
  });
});
