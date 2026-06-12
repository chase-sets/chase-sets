import { describe, expect, it } from "vitest";
import {
  MARKETPLACE_LAUNCH_EVIDENCE_SCHEMA_VERSION,
  validateMarketplaceLaunchEvidence,
} from "./marketplace-launch-evidence.mjs";

const now = new Date("2026-05-30T12:00:00.000Z");
const checkedAt = "2026-05-30T11:00:00.000Z";

function gate(reference, owner = "Operations") {
  return {
    approved: true,
    reference,
    owner,
    checkedAt,
  };
}

function checkoutLaunchGate(overrides = {}) {
  return {
    ...gate("CHECKOUT-LAUNCH-2026-05-30", "Checkout"),
    evidenceCompletedAt: "2026-05-30T10:55:00.000Z",
    environment: "production",
    releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
    matrixReference: "CHECKOUT-MATRIX-2026-05-30",
    matrixVersion: "checkout-launch-evidence-matrix/v1",
    matrixRowCount: 25,
    scenarioStateCount: 23,
    launchRegisterRowCount: 19,
    noSideEffectRowCount: 14,
    pendingDownstreamBoundaryRowCount: 5,
    freshStateCleanupRowCount: 25,
    measuredPerformanceRowCount: 25,
    visualSnapshotCount: 4,
    mobileViewportCount: 2,
    accessibilityScenarioCount: 12,
    e2eScenarioCount: 12,
    canaryArtifactCount: 4,
    entrySourcesCovered: ["buy-now", "buy-cart-readiness", "sell-list-readiness"],
    actorModesCovered: ["guest", "signed-in"],
    viewportsCovered: ["desktop", "mobile"],
    copyPolicyReference: "CHECKOUT-COPY-POLICY-2026-05-30",
    visualTargetsReference: "CHECKOUT-VISUAL-TARGETS-2026-05-30",
    performanceBudgetReference: "CHECKOUT-PERFORMANCE-BUDGETS-2026-05-30",
    coverageArtifactReference: "CHECKOUT-COVERAGE-2026-05-30",
    performanceMeasurementReference: "CHECKOUT-PERFORMANCE-MEASUREMENTS-2026-05-30",
    productionProofCanaryReference: "CHECKOUT-PRODUCTION-PROOF-CANARY-2026-05-30",
    noSideEffectReference: "CHECKOUT-NO-SIDE-EFFECT-2026-05-30",
    noCompatibilityScanReference: "CHECKOUT-NO-COMPATIBILITY-SCAN-2026-05-30",
    freshStateCleanupReference: "CHECKOUT-FRESH-STATE-CLEANUP-2026-05-30",
    launchRegisterReference: "CHECKOUT-LAUNCH-REGISTER-2026-05-30",
    observabilityReference: "CHECKOUT-OBSERVABILITY-2026-05-30",
    supportReference: "CHECKOUT-SUPPORT-2026-05-30",
    securityPolicyReference: "CHECKOUT-SECURITY-POLICY-2026-05-30",
    stagingWorkflowRunReference: "platform-deploy-staging-26688444710",
    productionWorkflowRunReference: "platform-deploy-production-26688444710",
    currentMainRevalidated: true,
    buyGuestCovered: true,
    buySignedInCovered: true,
    sellGuestCovered: true,
    sellSignedInCovered: true,
    productionProofBuyNowReadyWithinSlo: true,
    unassignedFulfillmentOutsideCheckoutProven: true,
    optimizationDecisionOutsideCheckoutProven: true,
    pendingDownstreamBoundaryProven: true,
    noCustomerCommittingSideEffectsBeforeConfirm: true,
    freshStateCleanupPassed: true,
    killSwitchFailClosedProven: true,
    legacyCompatibilityAbsent: true,
    visualMobileAccessibilityPassed: true,
    ...overrides,
  };
}

function validPacket(overrides = {}) {
  const packet = {
    schemaVersion: MARKETPLACE_LAUNCH_EVIDENCE_SCHEMA_VERSION,
    environment: "production",
    productionEnvironment: {
      PRODUCTION_MARKETPLACE_PUBLIC_ENABLED: "false",
      PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE: "MARKETPLACE-LAUNCH-EVIDENCE-2026-05-30",
      PRODUCTION_MARKETPLACE_PROOF_ENABLED: "false",
      PRODUCTION_MARKETPLACE_PROOF_REFERENCE: "",
      PRODUCTION_MARKETPLACE_PROMOTION_APPROVED: "true",
      PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE: "LAUNCH-REVIEW-2026-05-30",
      PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED: "true",
      PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE: "PAYMENTS-FEE-2026-05-30",
      PRODUCTION_CHECKOUT_LAUNCH_EVIDENCE_APPROVED: "true",
      PRODUCTION_CHECKOUT_LAUNCH_EVIDENCE_REFERENCE: "CHECKOUT-LAUNCH-2026-05-30",
      PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED: "true",
      PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE: "STRIPE-MONEY-2026-05-30",
      PRODUCTION_SUPPORT_OPERATIONS_APPROVED: "true",
      PRODUCTION_SUPPORT_OPERATIONS_REFERENCE: "SUPPORT-OPS-2026-05-30",
      PRODUCTION_FULFILLMENT_POSTAGE_APPROVED: "true",
      PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE: "FULFILLMENT-POSTAGE-2026-05-30",
      PRODUCTION_TRANSACTIONAL_EMAIL_APPROVED: "true",
      PRODUCTION_TRANSACTIONAL_EMAIL_REFERENCE: "NOTIFICATIONS-SES-2026-05-30",
      PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_APPROVED: "true",
      PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE: "CATALOG-MEASURES-2026-05-30",
      PRODUCTION_TAX_READINESS_APPROVED: "true",
      PRODUCTION_TAX_READINESS_REFERENCE: "TAX-READINESS-2026-05-30",
      TAX_PROVIDER_BACKED_QUOTES_REQUIRED: "false",
    },
    gates: {
      marketplacePromotion: {
        ...gate("LAUNCH-REVIEW-2026-05-30", "Platform"),
        reviewReference: "LAUNCH-REVIEW-PROOF-2026-05-30",
        reviewCompletedAt: "2026-05-30T10:10:00.000Z",
        environment: "production",
        finalLaunchReviewApproved: true,
        publicPresenceLaunchCopyReviewed: true,
        futureOnlyLaunchCopyRemoved: true,
        policyPagesReviewed: true,
        rollbackOwnerAssigned: true,
        releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
        stagingWorkflowRunReference: "platform-deploy-staging-26688444710",
        productionWorkflowRunReference: "platform-deploy-production-26688444710",
        publicPresenceReviewReference: "PUBLIC-PRESENCE-LAUNCH-COPY-2026-05-30",
        publicPresenceCopyAuditReference: "PUBLIC-PRESENCE-COPY-AUDIT-2026-05-30",
        publicPresenceCopyAuditVersion: "marketplace-public-presence-copy-audit/v1",
        publicPresenceCopyAuditBaseUrl: "https://chasesets.com",
        publicPresenceCopyAuditCompletedAt: "2026-05-30T10:00:00.000Z",
        publicPresenceCopyAuditMode: "launch",
        publicPresenceCopyAuditRequiredPageCount: 8,
        publicPresenceCopyAuditPassed: true,
        publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved: true,
        publicPresenceCopyAuditPolicyPagesReviewed: true,
        publicPresenceCopyAuditUncertifiedClaimsAbsent: true,
        policyPagesReviewReference: "PUBLIC-POLICY-PAGES-2026-05-30",
        rollbackOwnerReference: "ROLLBACK-OWNER-2026-05-30",
      },
      marketplaceCheckoutFee: {
        ...gate("PAYMENTS-FEE-2026-05-30", "Payments"),
        approvalReference: "PAYMENTS-FEE-APPROVAL-2026-05-30",
        approvalCompletedAt: "2026-05-30T10:20:00.000Z",
        environment: "production",
        releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
        feePolicyVersion: "marketplace-checkout-fee-v1",
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
        livePolicyEndpointCheckedAt: "2026-05-30T10:18:00.000Z",
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
      },
      checkoutLaunchEvidence: checkoutLaunchGate(),
      stripeMoneyOperations: {
        ...gate("STRIPE-MONEY-2026-05-30", "Payments and Settlement"),
        proofReference: "STRIPE-MONEY-PROOF-2026-05-30",
        proofCompletedAt: "2026-05-30T10:25:00.000Z",
        environment: "live",
        releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
        apiVersion: "2026-03-25.dahlia",
        paymentWebhookDestination: "https://marketplace.chasesets.com/api/payments/provider/webhooks",
        connectWebhookDestination: "https://marketplace.chasesets.com/api/settlement/provider/money-movement/webhooks",
        connectCustomAccountProofCompletedAt: "2026-05-30T10:20:00.000Z",
        connectPayoutSetupPageUrl: "https://marketplace.chasesets.com/account/payouts/setup",
        connectPayoutSetupPageEvidenceKind: "screenshot",
        connectDashboardAccess: "none",
        connectControllerFeesPayer: "application",
        connectControllerLossesCollector: "application",
        connectControllerRequirementCollection: "application",
        connectConnectedAccountCount: 1,
        connectCustomDashboardNoneAccountCount: 1,
        connectEmbeddedSetupSessionCount: 2,
        connectLegacyHostedAccountCount: 0,
        connectLegacyPayoutReadyAccountCount: 0,
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
        connectLegacyMigrationReportReference: "STRIPE-CONNECT-MIGRATION-REPORT-2026-05-30",
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
        connectLegacyMigrationReportReviewed: true,
        payoutReadinessProven: true,
        payoutPreviewAndRequestProven: true,
        transferAndConnectedAccountPayoutProven: true,
        payoutFailureReversalProven: true,
        reconciliationProven: true,
        platformBalanceFundingProven: true,
        webhookReplayProven: true,
        radarRiskPostureApproved: true,
      },
      supportOperations: {
        ...gate("SUPPORT-OPS-2026-05-30", "Support"),
        rehearsalReference: "SUPPORT-REHEARSAL-2026-05-30",
        rehearsalCompletedAt: "2026-05-30T10:45:00.000Z",
        environment: "staging",
        releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
        buyerSupportRequestId: "sup_buyer_rehearsal_20260530",
        sellerSupportRequestId: "sup_seller_rehearsal_20260530",
        operationsQueueReviewReference: "SUPPORT-QUEUE-REVIEW-2026-05-30",
        overdueEscalationResultReference: "SUPPORT-OVERDUE-ESCALATION-2026-05-30",
        lifecycleEndpointResultReference: "SUPPORT-LIFECYCLE-ENDPOINTS-2026-05-30",
        refundResolutionSupportRequestId: "sup_buyer_rehearsal_20260530",
        refundEffectId: "sre_buyer_rehearsal_20260530",
        refundId: "rfd_support_rehearsal_20260530",
        refundEffectReference: "PAYMENTS-SUPPORT-REFUND-EFFECT-2026-05-30",
        settlementHoldId: "hold_support_rehearsal_20260530",
        settlementHoldReference: "SETTLEMENT-SUPPORT-HOLD-2026-05-30",
        settlementHoldReleaseReference: "SETTLEMENT-SUPPORT-HOLD-RELEASE-2026-05-30",
        supportNotificationReference: "NOTIFICATIONS-SUPPORT-2026-05-30",
        buyerIssueOpeningProven: true,
        sellerIssueOpeningProven: true,
        operationsQueueReviewProven: true,
        overdueEscalationProven: true,
        lifecycleEndpointsProven: true,
        refundProducingResolutionProven: true,
        settlementHoldCoordinationProven: true,
        supportNotificationsProven: true,
      },
      fulfillmentPostage: {
        ...gate("FULFILLMENT-POSTAGE-2026-05-30", "Fulfillment"),
        proofReference: "FULFILLMENT-POSTAGE-PROOF-2026-05-30",
        proofCompletedAt: "2026-05-30T10:35:00.000Z",
        environment: "production",
        releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
        easyPostMode: "production",
        webhookDestination: "https://marketplace.chasesets.com/api/fulfillment/provider/postage/webhooks",
        providerEventRowCount: 4,
        matchedShipmentProviderEventRowCount: 4,
        trackingStatusProviderEventRowCount: 3,
        refundStatusProviderEventRowCount: 1,
        controlledParcelShipmentId: "ship_controlled_parcel_20260530",
        parcelProviderShipmentId: "shp_controlledParcel20260530",
        parcelProviderLabelId: "pl_controlledParcel20260530",
        trackingProviderObjectReference: "trk_controlledParcel20260530",
        trackingIdentifier: "9400111202555012345678",
        deliveryExceptionEvidenceKind: "provider-event",
        deliveryExceptionProviderEventId: "evt_deliveryException20260530",
        labelVoidRefundProviderObjectReference: "rfnd_labelVoid20260530",
        letterMailpieceShipmentId: "ship_letter_mailpiece_20260530",
        providerEventIds: [
          "evt_trackingPreTransit20260530",
          "evt_trackingInTransit20260530",
          "evt_trackingException20260530",
          "evt_refundStatus20260530",
        ],
        trackingStatusProviderEventIds: [
          "evt_trackingPreTransit20260530",
          "evt_trackingInTransit20260530",
          "evt_trackingException20260530",
        ],
        refundStatusProviderEventIds: ["evt_refundStatus20260530"],
        easyPostAccountReference: "EASYPOST-ACCOUNT-2026-05-30",
        webhookDestinationReference: "EASYPOST-WEBHOOK-DESTINATION-2026-05-30",
        providerEventQueryReference: "FULFILLMENT-POSTAGE-PROVIDER-EVENTS-2026-05-30",
        parcelLabelReference: "EASYPOST-LABEL-PURCHASE-2026-05-30",
        labelVoidRefundReference: "EASYPOST-LABEL-VOID-REFUND-2026-05-30",
        trackingEventReference: "EASYPOST-TRACKING-EVENT-2026-05-30",
        deliveryExceptionReference: "EASYPOST-DELIVERY-EXCEPTION-2026-05-30",
        letterMailpieceReference: "LETTER-MAILPIECE-HANDLING-2026-05-30",
        easyPostProductionModeProven: true,
        webhookDestinationConfigured: true,
        providerEventRowsProven: true,
        parcelLabelPurchaseProven: true,
        labelVoidRefundProven: true,
        trackingEventProven: true,
        deliveryExceptionProven: true,
        letterMailpieceHandlingProven: true,
      },
      transactionalEmail: {
        ...gate("NOTIFICATIONS-SES-2026-05-30", "Notifications"),
        proofReference: "NOTIFICATIONS-SES-PROOF-2026-05-30",
        proofCompletedAt: "2026-05-30T10:40:00.000Z",
        environment: "production",
        releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
        sesConfigurationSetName: "transactional-production",
        webhookDestination: "https://marketplace.chasesets.com/api/notifications/provider/email/webhooks",
        providerEventRowCount: 3,
        controlledSendProviderMessageId: "ses_msg_controlled_20260530",
        outboxRowId: "42",
        deliveryProviderEventId: "amazon-ses:ses_msg_controlled_20260530:delivery:2026-05-30T10:51:00.000Z",
        bounceProviderEventId: "amazon-ses:ses_msg_bounce_20260530:bounce:2026-05-30T10:52:00.000Z",
        complaintProviderEventId: "amazon-ses:ses_msg_complaint_20260530:complaint:2026-05-30T10:53:00.000Z",
        sesIdentityReference: "SES-IDENTITY-CHASESETS-COM-2026-05-30",
        controlledSendMessageReference: "SES-MESSAGE-CONTROLLED-SEND-2026-05-30",
        outboxDispatchReference: "NOTIFICATION-OUTBOX-DISPATCH-2026-05-30",
        deliveryEventReference: "SES-DELIVERY-EVENT-2026-05-30",
        bounceEventReference: "SES-BOUNCE-EVENT-2026-05-30",
        complaintEventReference: "SES-COMPLAINT-EVENT-2026-05-30",
        deliveryMonitoringReference: "SES-MONITORING-2026-05-30",
        snsSubscriptionConfirmationReference: "SNS-SUBSCRIPTION-CONFIRMATION-2026-05-30",
        templateReviewReference: "TRANSACTIONAL-TEMPLATE-REVIEW-2026-05-30",
        sesDnsVerified: true,
        controlledSendProven: true,
        outboxDispatchProven: true,
        bounceComplaintParsingProven: true,
        deliveryMonitoringProven: true,
        webhookDestinationConfigured: true,
        snsSubscriptionConfirmed: true,
        criticalTemplateAreasCovered: ["auth", "orders", "payments", "fulfillment", "refunds", "support", "payouts"],
      },
      launchSupplyMeasurements: {
        ...gate("CATALOG-MEASURES-2026-05-30", "Catalog"),
        queryVersion: "launch-supply-measurement-query/v1",
        environment: "production",
        activeLaunchListingCount: 42,
        activeLaunchSellerAccountCount: 7,
        sampledActiveLaunchListingIds: ["lst_1", "lst_2", "lst_3"],
        activeLaunchListingsMissingResolvedProductMeasures: 0,
        resolvedProductMeasureCoveragePercent: 100,
        queryReference: "launch-supply-measurement-query-2026-05-30",
        operator: "ops@chasesets.com",
        projectionFreshnessReference: "projection-freshness-2026-05-30",
      },
      taxReadiness: {
        ...gate("TAX-READINESS-2026-05-30", "Tax"),
        posture: "no_collection_required",
        collectionRequiredJurisdictions: [],
        taxProviderBackedQuotesRequired: false,
        providerBackedResolverComposed: false,
        counselAccountingApprovalReference: "tax-counsel-2026-05-30",
        stateByStateNexusReference: "tax-nexus-2026-05-30",
        providerDecisionReference: "tax-provider-decision-2026-05-30",
        thresholdPolicyReference: "tax-threshold-policy-2026-05-30",
        nexusMonitoringReference: "tax-nexus-monitoring-2026-05-30",
        nexusReportAsOf: "2026-05-30T10:30:00.000Z",
        sourceMeasurementReference: "TAX-NEXUS-SOURCE-2026-05-30",
        sourceMeasurementEnvironment: "production",
        sourceMeasurementQueryVersion: "tax-nexus-measurement-query/v1",
        sourceMeasurementCheckedAt: "2026-05-30T10:20:00.000Z",
        sourceMeasurementProjectionFreshnessReference: "ORDERING-PROJECTION-FRESHNESS-2026-05-30",
        sourceMeasurementQueryWindow: {
          previousYearStart: "2025-01-01T00:00:00.000Z",
          currentYearStart: "2026-01-01T00:00:00.000Z",
          nextYearStart: "2027-01-01T00:00:00.000Z",
        },
        sourceMeasurementJurisdictionCount: 51,
        sourceMeasurementMissingJurisdictionOrderCount: 0,
        sourceMeasurementUnknownJurisdictionOrderCount: 0,
        sourceMeasurementRequiresManualReview: false,
        sourceMeasurementPasses: true,
        stateByStateJurisdictionReviewCount: 51,
        providerBackedQuotesMissing: false,
        registrationRequiredJurisdictions: [],
        preparationJurisdictions: [],
        manualReviewJurisdictions: ["AK", "CO", "LA"],
      },
      ucpAp2Marketing: {
        owner: "Checkout and Payments",
        publicLaunchClaimsEnabled: false,
        certificationApproved: false,
        certificationReference: "",
        claimsReviewReference: "ucp-ap2-copy-review-2026-05-30",
        uncertifiedClaimsAbsent: true,
      },
    },
  };

  return {
    ...packet,
    ...overrides,
    productionEnvironment: {
      ...packet.productionEnvironment,
      ...(overrides.productionEnvironment ?? {}),
    },
    gates: {
      ...packet.gates,
      ...(overrides.gates ?? {}),
    },
  };
}

describe("marketplace launch evidence verifier", () => {
  it("accepts a complete launch packet while the public switch remains false", () => {
    const result = validateMarketplaceLaunchEvidence(validPacket(), { now });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary.requiredGates).toContain("checkoutLaunchEvidence");
  });

  it("requires checkout launch evidence as a first-class approval gate", () => {
    const { checkoutLaunchEvidence: _checkoutLaunchEvidence, ...gates } = validPacket().gates;
    const packet = validPacket();
    packet.gates = gates;
    const result = validateMarketplaceLaunchEvidence(packet, { now });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Checkout launch evidence gate is required at gates.checkoutLaunchEvidence.");
  });

  it("fails checkout launch evidence that does not prove the full current-main matrix", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          checkoutLaunchEvidence: checkoutLaunchGate({
            currentMainRevalidated: false,
            matrixVersion: "checkout-launch-matrix/v0",
            matrixRowCount: 24,
            measuredPerformanceRowCount: 3,
            productionProofCanaryReference: "placeholder",
            productionProofBuyNowReadyWithinSlo: false,
            canaryArtifactCount: 3,
            visualSnapshotCount: 4.5,
            noCompatibilityScanReference: "placeholder",
            entrySourcesCovered: ["buy-now"],
            actorModesCovered: ["guest"],
            viewportsCovered: ["desktop"],
          }),
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Checkout launch evidence must have currentMainRevalidated=true.");
    expect(result.errors).toContain(
      "Checkout launch evidence matrixVersion must be checkout-launch-evidence-matrix/v1.",
    );
    expect(result.errors).toContain("Checkout launch evidence matrixRowCount must be at least 25.");
    expect(result.errors).toContain("Checkout launch evidence measuredPerformanceRowCount must be at least 25.");
    expect(result.errors).toContain("Checkout launch evidence must have productionProofBuyNowReadyWithinSlo=true.");
    expect(result.errors).toContain("Checkout launch evidence canaryArtifactCount must be at least 4.");
    expect(result.errors).toContain(
      "Checkout launch evidence productionProofCanaryReference must point to a real external evidence record, not a placeholder.",
    );
    expect(result.errors).toContain("Checkout launch evidence visualSnapshotCount must be an integer.");
    expect(result.errors).toContain(
      "Checkout launch evidence noCompatibilityScanReference must point to a real external evidence record, not a placeholder.",
    );
    expect(result.errors).toContain("Checkout launch evidence entrySourcesCovered must include buy-cart-readiness.");
    expect(result.errors).toContain("Checkout launch evidence entrySourcesCovered must include sell-list-readiness.");
    expect(result.errors).toContain("Checkout launch evidence actorModesCovered must include signed-in.");
    expect(result.errors).toContain("Checkout launch evidence viewportsCovered must include mobile.");
  });

  it("allows proof mode only with a real reference while public promotion remains closed", () => {
    expect(
      validateMarketplaceLaunchEvidence(
        validPacket({
          productionEnvironment: {
            PRODUCTION_MARKETPLACE_PROOF_ENABLED: "true",
            PRODUCTION_MARKETPLACE_PROOF_REFERENCE: "PRODUCTION-PROOF-2026-05-30",
          },
        }),
        { now },
      ).ok,
    ).toBe(true);

    const missingReference = validateMarketplaceLaunchEvidence(
      validPacket({
        productionEnvironment: {
          PRODUCTION_MARKETPLACE_PROOF_ENABLED: "true",
          PRODUCTION_MARKETPLACE_PROOF_REFERENCE: "",
        },
      }),
      { now },
    );
    expect(missingReference.ok).toBe(false);
    expect(missingReference.errors).toContain("PRODUCTION_MARKETPLACE_PROOF_REFERENCE is required.");

    const publicAndProof = validateMarketplaceLaunchEvidence(
      validPacket({
        productionEnvironment: {
          PRODUCTION_MARKETPLACE_PUBLIC_ENABLED: "true",
          PRODUCTION_MARKETPLACE_PROOF_ENABLED: "true",
          PRODUCTION_MARKETPLACE_PROOF_REFERENCE: "PRODUCTION-PROOF-2026-05-30",
        },
      }),
      { now },
    );
    expect(publicAndProof.ok).toBe(false);
    expect(publicAndProof.errors).toContain(
      "PRODUCTION_MARKETPLACE_PROOF_ENABLED must be false when PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true.",
    );
  });

  it("fails when a required gate approval is stale", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          marketplacePromotion: {
            ...validPacket().gates.marketplacePromotion,
            checkedAt: "2026-04-01T00:00:00.000Z",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Marketplace promotion evidence cannot be older than 30 days.");
    expect(result.warnings).toEqual([]);
  });

  it("fails when launch packet timestamps are date-only values", () => {
    const base = validPacket();
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          marketplacePromotion: {
            ...base.gates.marketplacePromotion,
            checkedAt: "2026-05-30",
            reviewCompletedAt: "2026-05-30",
            publicPresenceCopyAuditCompletedAt: "2026-05-30",
          },
          marketplaceCheckoutFee: {
            ...base.gates.marketplaceCheckoutFee,
            feePolicyEffectiveAt: "2026-05-30",
          },
          stripeMoneyOperations: {
            ...base.gates.stripeMoneyOperations,
            proofCompletedAt: "2026-05-30",
          },
          supportOperations: {
            ...base.gates.supportOperations,
            rehearsalCompletedAt: "2026-05-30",
          },
          taxReadiness: {
            ...base.gates.taxReadiness,
            nexusReportAsOf: "2026-05-30",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Marketplace promotion checkedAt must be an ISO timestamp.");
    expect(result.errors).toContain("Marketplace promotion reviewCompletedAt must be an ISO timestamp.");
    expect(result.errors).toContain(
      "Marketplace promotion publicPresenceCopyAuditCompletedAt must be an ISO timestamp.",
    );
    expect(result.errors).toContain("Marketplace Checkout Fee feePolicyEffectiveAt must be an ISO timestamp.");
    expect(result.errors).toContain("Stripe money operations proofCompletedAt must be an ISO timestamp.");
    expect(result.errors).toContain("Support operations rehearsalCompletedAt must be an ISO timestamp.");
    expect(result.errors).toContain("Tax readiness nexusReportAsOf must be an ISO timestamp.");
  });

  it("fails when launch supply has active listings without resolved product measures", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          launchSupplyMeasurements: {
            ...validPacket().gates.launchSupplyMeasurements,
            activeLaunchListingsMissingResolvedProductMeasures: 1,
            resolvedProductMeasureCoveragePercent: 97.5,
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Launch supply measurements must have activeLaunchListingsMissingResolvedProductMeasures=0.",
    );
    expect(result.errors).toContain("Launch supply measurements must have resolvedProductMeasureCoveragePercent=100.");
  });

  it("fails when launch supply measurement lacks seller and listing-sample proof", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          launchSupplyMeasurements: {
            ...validPacket().gates.launchSupplyMeasurements,
            activeLaunchSellerAccountCount: 0,
            sampledActiveLaunchListingIds: ["lst_1", "lst_1"],
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Launch supply measurements must include activeLaunchSellerAccountCount between 1 and activeLaunchListingCount.",
    );
    expect(result.errors).toContain("Launch supply measurements sampledActiveLaunchListingIds must be distinct.");
  });

  it("fails when launch supply measurement is not production-scoped", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          launchSupplyMeasurements: {
            ...validPacket().gates.launchSupplyMeasurements,
            environment: "staging",
            queryVersion: "old-query/v0",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Launch supply measurements environment must be production.");
    expect(result.errors).toContain(
      "Launch supply measurements queryVersion must be launch-supply-measurement-query/v1.",
    );
  });

  it("fails when launch supply queryReference only names the query version", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          launchSupplyMeasurements: {
            ...validPacket().gates.launchSupplyMeasurements,
            queryReference: "launch-supply-measurement-query/v1",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Launch supply measurements queryReference must point to the production query evidence record.",
    );
  });

  it("fails when marketplace promotion omits launch copy review references", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          marketplacePromotion: {
            ...validPacket().gates.marketplacePromotion,
            environment: "staging",
            publicPresenceReviewReference: "",
            publicPresenceCopyAuditReference: "",
            publicPresenceCopyAuditVersion: "copy-audit/v0",
            publicPresenceCopyAuditBaseUrl: "https://staging.chasesets.com",
            publicPresenceCopyAuditCompletedAt: "2026-04-15T10:00:00.000Z",
            publicPresenceCopyAuditMode: "prelaunch",
            publicPresenceCopyAuditRequiredPageCount: 7,
            publicPresenceCopyAuditPassed: false,
            publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved: false,
            publicPresenceCopyAuditPolicyPagesReviewed: false,
            publicPresenceCopyAuditUncertifiedClaimsAbsent: false,
            policyPagesReviewReference: "",
            rollbackOwnerReference: "",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Marketplace promotion environment must be production.");
    expect(result.errors).toContain("Marketplace promotion must include publicPresenceReviewReference.");
    expect(result.errors).toContain("Marketplace promotion must include publicPresenceCopyAuditReference.");
    expect(result.errors).toContain(
      "Marketplace promotion must include publicPresenceCopyAuditVersion=marketplace-public-presence-copy-audit/v1.",
    );
    expect(result.errors).toContain(
      "Marketplace promotion publicPresenceCopyAuditBaseUrl must use https://chasesets.com.",
    );
    expect(result.errors).toContain(
      "Marketplace promotion publicPresenceCopyAuditCompletedAt cannot be older than 30 days.",
    );
    expect(result.errors).toContain("Marketplace promotion must include publicPresenceCopyAuditMode=launch.");
    expect(result.errors).toContain("Marketplace promotion must include publicPresenceCopyAuditRequiredPageCount=8.");
    expect(result.errors).toContain("Marketplace promotion must have publicPresenceCopyAuditPassed=true.");
    expect(result.errors).toContain(
      "Marketplace promotion must have publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved=true.",
    );
    expect(result.errors).toContain("Marketplace promotion must have publicPresenceCopyAuditPolicyPagesReviewed=true.");
    expect(result.errors).toContain(
      "Marketplace promotion must have publicPresenceCopyAuditUncertifiedClaimsAbsent=true.",
    );
    expect(result.errors).toContain("Marketplace promotion must include policyPagesReviewReference.");
    expect(result.errors).toContain("Marketplace promotion must include rollbackOwnerReference.");
  });

  it("fails when Marketplace promotion omits launch review completion timestamps", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          marketplacePromotion: {
            ...validPacket().gates.marketplacePromotion,
            reviewCompletedAt: "",
            publicPresenceCopyAuditCompletedAt: "",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Marketplace promotion must include reviewCompletedAt.");
    expect(result.errors).toContain("Marketplace promotion must include publicPresenceCopyAuditCompletedAt.");
  });

  it("fails when Marketplace Checkout Fee omits production fee approval references", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          marketplaceCheckoutFee: {
            ...validPacket().gates.marketplaceCheckoutFee,
            environment: "staging",
            stripeMode: "test",
            approvalCompletedAt: "2026-04-15T10:20:00.000Z",
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
            livePolicyEndpointUrl:
              "https://staging.chasesets.com/api/marketplace/account/marketplace-checkout-fee-policy",
            livePolicyEndpointStatusCode: 404,
            livePolicyEndpointCheckedAt: "2026-05-30",
            livePolicyEndpointReference: "",
            buyerFacingCopyReference: "",
            stripeLiveFeeConfigurationReference: "",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Marketplace Checkout Fee environment must be production.");
    expect(result.errors).toContain("Marketplace Checkout Fee stripeMode must be live.");
    expect(result.errors).toContain("Marketplace Checkout Fee approvalCompletedAt cannot be older than 30 days.");
    expect(result.errors).toContain("Marketplace Checkout Fee feePolicyVersion must be marketplace-checkout-fee-v1.");
    expect(result.errors).toContain("Marketplace Checkout Fee feePolicyEffectiveAt must be an ISO timestamp.");
    expect(result.errors).toContain(
      "Marketplace Checkout Fee enabledJurisdictions must match the live policy endpoint: US.",
    );
    expect(result.errors).toContain(
      "Marketplace Checkout Fee base policy must match the live card policy: 290 bps plus 0.30.",
    );
    expect(result.errors).toContain(
      "Marketplace Checkout Fee bank-account policy must match the live policy: 50 bps plus 0.00.",
    );
    expect(result.errors).toContain(
      "Marketplace Checkout Fee platform-credit policy must match the live policy: 0 bps plus 0.00.",
    );
    expect(result.errors).toContain(
      "Marketplace Checkout Fee unsupportedMethodsDefault must match the live policy: no-positive-fee.",
    );
    expect(result.errors).toContain("Marketplace Checkout Fee feeQuoteConfirmationRequired must be true.");
    expect(result.errors).toContain(
      "Marketplace Checkout Fee stale quote response must match the live policy: 409 fee_quote_stale.",
    );
    expect(result.errors).toContain(
      "Marketplace Checkout Fee livePolicyEndpointUrl must use /api/marketplace/account/marketplace-checkout-fee-policy on a production Chase Sets host.",
    );
    expect(result.errors).toContain("Marketplace Checkout Fee livePolicyEndpointStatusCode must be 200.");
    expect(result.errors).toContain("Marketplace Checkout Fee livePolicyEndpointCheckedAt must be an ISO timestamp.");
    expect(result.errors).toContain("Marketplace Checkout Fee must include livePolicyEndpointReference.");
    expect(result.errors).toContain("Marketplace Checkout Fee must include buyerFacingCopyReference.");
    expect(result.errors).toContain("Marketplace Checkout Fee must include stripeLiveFeeConfigurationReference.");
  });

  it("fails when Marketplace Checkout Fee omits approval completion timestamp", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          marketplaceCheckoutFee: {
            ...validPacket().gates.marketplaceCheckoutFee,
            approvalCompletedAt: "",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Marketplace Checkout Fee must include approvalCompletedAt.");
  });

  it("rejects placeholder detailed evidence references across launch gates", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          marketplacePromotion: {
            ...validPacket().gates.marketplacePromotion,
            publicPresenceCopyAuditReference: "TBD",
          },
          marketplaceCheckoutFee: {
            ...validPacket().gates.marketplaceCheckoutFee,
            approvalReference: "placeholder",
          },
          checkoutLaunchEvidence: {
            ...validPacket().gates.checkoutLaunchEvidence,
            noSideEffectReference: "sample",
          },
          stripeMoneyOperations: {
            ...validPacket().gates.stripeMoneyOperations,
            proofReference: "example",
            refundReference: "ticket",
          },
          supportOperations: {
            ...validPacket().gates.supportOperations,
            refundEffectReference: "ticket",
          },
          fulfillmentPostage: {
            ...validPacket().gates.fulfillmentPostage,
            parcelLabelReference: "record",
          },
          transactionalEmail: {
            ...validPacket().gates.transactionalEmail,
            bounceEventReference: "n/a",
          },
          launchSupplyMeasurements: {
            ...validPacket().gates.launchSupplyMeasurements,
            projectionFreshnessReference: "todo",
          },
          taxReadiness: {
            ...validPacket().gates.taxReadiness,
            sourceMeasurementReference: "sample",
          },
          ucpAp2Marketing: {
            ...validPacket().gates.ucpAp2Marketing,
            claimsReviewReference: "none",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Marketplace promotion publicPresenceCopyAuditReference must point to a real external evidence record, not a placeholder.",
    );
    expect(result.errors).toContain(
      "Marketplace Checkout Fee approvalReference must point to a real external evidence record, not a placeholder.",
    );
    expect(result.errors).toContain(
      "Checkout launch evidence noSideEffectReference must point to a real external evidence record, not a placeholder.",
    );
    expect(result.errors).toContain(
      "Stripe money operations proofReference must point to a real external evidence record, not a placeholder.",
    );
    expect(result.errors).toContain(
      "Stripe money operations refundReference must point to a real external evidence record, not a placeholder.",
    );
    expect(result.errors).toContain(
      "Support operations refundEffectReference must point to a real external evidence record, not a placeholder.",
    );
    expect(result.errors).toContain(
      "Fulfillment postage parcelLabelReference must point to a real external evidence record, not a placeholder.",
    );
    expect(result.errors).toContain(
      "Transactional email bounceEventReference must point to a real external evidence record, not a placeholder.",
    );
    expect(result.errors).toContain(
      "Launch supply measurements projectionFreshnessReference must point to a real external evidence record, not a placeholder.",
    );
    expect(result.errors).toContain(
      "Tax readiness sourceMeasurementReference must point to a real external evidence record, not a placeholder.",
    );
    expect(result.errors).toContain(
      "UCP/AP2 marketing claimsReviewReference must point to a real external evidence record, not a placeholder.",
    );
  });

  it("requires release-scoped gates to match the marketplace promotion release commit", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          marketplaceCheckoutFee: {
            ...validPacket().gates.marketplaceCheckoutFee,
            releaseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          checkoutLaunchEvidence: {
            ...validPacket().gates.checkoutLaunchEvidence,
            releaseCommit: "9999999999999999999999999999999999999999",
          },
          stripeMoneyOperations: {
            ...validPacket().gates.stripeMoneyOperations,
            releaseCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          },
          supportOperations: {
            ...validPacket().gates.supportOperations,
            releaseCommit: "cccccccccccccccccccccccccccccccccccccccc",
          },
          fulfillmentPostage: {
            ...validPacket().gates.fulfillmentPostage,
            releaseCommit: "dddddddddddddddddddddddddddddddddddddddd",
          },
          transactionalEmail: {
            ...validPacket().gates.transactionalEmail,
            releaseCommit: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Marketplace Checkout Fee releaseCommit must match Marketplace promotion releaseCommit.",
    );
    expect(result.errors).toContain(
      "Checkout launch evidence releaseCommit must match Marketplace promotion releaseCommit.",
    );
    expect(result.errors).toContain(
      "Stripe money operations releaseCommit must match Marketplace promotion releaseCommit.",
    );
    expect(result.errors).toContain("Support operations releaseCommit must match Marketplace promotion releaseCommit.");
    expect(result.errors).toContain(
      "Fulfillment postage releaseCommit must match Marketplace promotion releaseCommit.",
    );
    expect(result.errors).toContain(
      "Transactional email releaseCommit must match Marketplace promotion releaseCommit.",
    );
  });

  it("requires release-scoped gates to use concrete 40-character Git commit SHAs", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          marketplacePromotion: {
            ...validPacket().gates.marketplacePromotion,
            releaseCommit: "launch-review",
          },
          marketplaceCheckoutFee: {
            ...validPacket().gates.marketplaceCheckoutFee,
            releaseCommit: "checkout-fee",
          },
          checkoutLaunchEvidence: {
            ...validPacket().gates.checkoutLaunchEvidence,
            releaseCommit: "checkout-launch",
          },
          stripeMoneyOperations: {
            ...validPacket().gates.stripeMoneyOperations,
            releaseCommit: "stripe-proof",
          },
          supportOperations: {
            ...validPacket().gates.supportOperations,
            releaseCommit: "support-rehearsal",
          },
          fulfillmentPostage: {
            ...validPacket().gates.fulfillmentPostage,
            releaseCommit: "postage-proof",
          },
          transactionalEmail: {
            ...validPacket().gates.transactionalEmail,
            releaseCommit: "email-proof",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Marketplace promotion releaseCommit must be a 40-character Git commit SHA.");
    expect(result.errors).toContain("Marketplace Checkout Fee releaseCommit must be a 40-character Git commit SHA.");
    expect(result.errors).toContain("Checkout launch evidence releaseCommit must be a 40-character Git commit SHA.");
    expect(result.errors).toContain("Stripe money operations releaseCommit must be a 40-character Git commit SHA.");
    expect(result.errors).toContain("Support operations releaseCommit must be a 40-character Git commit SHA.");
    expect(result.errors).toContain("Fulfillment postage releaseCommit must be a 40-character Git commit SHA.");
    expect(result.errors).toContain("Transactional email releaseCommit must be a 40-character Git commit SHA.");
  });

  it("fails a no-collection tax posture when a collection-required jurisdiction is present", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          taxReadiness: {
            ...validPacket().gates.taxReadiness,
            collectionRequiredJurisdictions: ["MN"],
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Tax readiness cannot use no_collection_required while collectionRequiredJurisdictions is non-empty.",
    );
  });

  it("requires provider-backed tax composition when collection is required", () => {
    const base = validPacket();
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        productionEnvironment: {
          TAX_PROVIDER_BACKED_QUOTES_REQUIRED: "true",
        },
        gates: {
          taxReadiness: {
            ...base.gates.taxReadiness,
            posture: "provider_backed_quotes_required",
            collectionRequiredJurisdictions: ["MN"],
            taxProviderBackedQuotesRequired: true,
            providerBackedResolverComposed: false,
            providerBackedQuotesMissing: false,
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Tax provider_backed_quotes_required posture requires providerBackedResolverComposed=true.",
    );
    expect(result.errors).toContain(
      "Tax provider_backed_quotes_required posture requires providerBackedResolverReference.",
    );
  });

  it("rejects placeholder provider-backed Tax resolver references", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        productionEnvironment: {
          TAX_PROVIDER_BACKED_QUOTES_REQUIRED: "true",
        },
        gates: {
          taxReadiness: {
            ...validPacket().gates.taxReadiness,
            posture: "provider_backed_quotes_required",
            collectionRequiredJurisdictions: ["MN"],
            taxProviderBackedQuotesRequired: true,
            providerBackedResolverComposed: true,
            providerBackedResolverReference: "todo",
            providerBackedQuotesMissing: false,
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Tax readiness providerBackedResolverReference must point to a real external evidence record, not a placeholder.",
    );
  });

  it("fails when Tax readiness uses stale nexus evidence", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          taxReadiness: {
            ...validPacket().gates.taxReadiness,
            nexusReportAsOf: "2026-04-01T00:00:00.000Z",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Tax readiness nexusReportAsOf cannot be older than 30 days.");
  });

  it("fails when Tax readiness source measurement is not production-scoped", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          taxReadiness: {
            ...validPacket().gates.taxReadiness,
            sourceMeasurementEnvironment: "staging",
            sourceMeasurementQueryVersion: "tax-nexus-measurement-query/v0",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Tax readiness sourceMeasurementEnvironment must be production.");
    expect(result.errors).toContain(
      "Tax readiness sourceMeasurementQueryVersion must be tax-nexus-measurement-query/v1.",
    );
  });

  it("fails when Tax readiness source measurement details do not prove a passing source sweep", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          taxReadiness: {
            ...validPacket().gates.taxReadiness,
            sourceMeasurementCheckedAt: "2026-05-30",
            sourceMeasurementProjectionFreshnessReference: "todo",
            sourceMeasurementQueryWindow: {
              previousYearStart: "2026-01-01T00:00:00.000Z",
              currentYearStart: "2025-01-01T00:00:00.000Z",
              nextYearStart: "2024-01-01T00:00:00.000Z",
            },
            sourceMeasurementJurisdictionCount: 50,
            sourceMeasurementMissingJurisdictionOrderCount: 1,
            sourceMeasurementUnknownJurisdictionOrderCount: 1,
            sourceMeasurementRequiresManualReview: true,
            sourceMeasurementPasses: false,
            stateByStateJurisdictionReviewCount: 50,
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Tax readiness sourceMeasurementProjectionFreshnessReference must point to a real external evidence record, not a placeholder.",
    );
    expect(result.errors).toContain("Tax readiness sourceMeasurementCheckedAt must be an ISO timestamp.");
    expect(result.errors).toContain(
      "Tax readiness sourceMeasurementQueryWindow.previousYearStart must be before currentYearStart.",
    );
    expect(result.errors).toContain(
      "Tax readiness sourceMeasurementQueryWindow.currentYearStart must be before nextYearStart.",
    );
    expect(result.errors).toContain("Tax readiness sourceMeasurementJurisdictionCount must be 51.");
    expect(result.errors).toContain("Tax readiness sourceMeasurementMissingJurisdictionOrderCount must be 0.");
    expect(result.errors).toContain("Tax readiness sourceMeasurementUnknownJurisdictionOrderCount must be 0.");
    expect(result.errors).toContain("Tax readiness sourceMeasurementRequiresManualReview must be false.");
    expect(result.errors).toContain("Tax readiness sourceMeasurementPasses must be true.");
    expect(result.errors).toContain("Tax readiness stateByStateJurisdictionReviewCount must be at least 51.");
  });

  it("fails when Tax readiness sourceMeasurementReference only names the query version", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          taxReadiness: {
            ...validPacket().gates.taxReadiness,
            sourceMeasurementReference: "tax-nexus-measurement-query/v1",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Tax readiness sourceMeasurementReference must point to the production source measurement record.",
    );
  });

  it("fails when Tax readiness omits nexus posture detail fields", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          taxReadiness: {
            ...validPacket().gates.taxReadiness,
            thresholdPolicyReference: "",
            nexusMonitoringReference: "n/a",
            providerBackedQuotesMissing: undefined,
            registrationRequiredJurisdictions: undefined,
            preparationJurisdictions: undefined,
            manualReviewJurisdictions: undefined,
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Tax readiness must include thresholdPolicyReference.");
    expect(result.errors).toContain(
      "Tax readiness nexusMonitoringReference must point to a real external evidence record, not a placeholder.",
    );
    expect(result.errors).toContain("Tax readiness must include providerBackedQuotesMissing as a boolean.");
    expect(result.errors).toContain("Tax readiness registrationRequiredJurisdictions must be an array.");
    expect(result.errors).toContain("Tax readiness preparationJurisdictions must be an array.");
    expect(result.errors).toContain("Tax readiness manualReviewJurisdictions must be an array.");
  });

  it("fails provider-backed Tax readiness when provider quotes are still missing", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        productionEnvironment: {
          TAX_PROVIDER_BACKED_QUOTES_REQUIRED: "true",
        },
        gates: {
          taxReadiness: {
            ...validPacket().gates.taxReadiness,
            posture: "provider_backed_quotes_required",
            collectionRequiredJurisdictions: ["MN"],
            taxProviderBackedQuotesRequired: true,
            providerBackedResolverComposed: true,
            providerBackedQuotesMissing: true,
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Tax provider_backed_quotes_required posture requires providerBackedQuotesMissing=false.",
    );
  });

  it("fails when Stripe money operations only has a generic approval reference", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          stripeMoneyOperations: gate("STRIPE-MONEY-2026-05-30", "Payments and Settlement"),
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Stripe money operations must have liveCheckoutProven=true.");
    expect(result.errors).toContain("Stripe money operations must have payoutFailureReversalProven=true.");
    expect(result.errors).toContain("Stripe money operations must have radarRiskPostureApproved=true.");
    expect(result.errors).toContain("Stripe money operations must include proofReference.");
    expect(result.errors).toContain("Stripe money operations must include environment.");
    expect(result.errors).toContain("Stripe money operations must include releaseCommit.");
    expect(result.errors).toContain("Stripe money operations must include apiVersion.");
    expect(result.errors).toContain("Stripe money operations must include at least one live connected account.");
    expect(result.errors).toContain("Stripe money operations must include paymentWebhookDestination.");
    expect(result.errors).toContain("Stripe money operations must include connectWebhookDestination.");
    expect(result.errors).toContain("Stripe money operations must include connectCustomAccountProofCompletedAt.");
    expect(result.errors).toContain("Stripe money operations must include connectPayoutSetupPageUrl.");
    expect(result.errors).toContain("Stripe money operations must include connectPayoutSetupPageEvidenceKind.");
    expect(result.errors).toContain("Stripe money operations must include proofCompletedAt.");
    expect(result.errors).toContain("Stripe money operations must include livePaymentIntentId.");
    expect(result.errors).toContain("Stripe money operations must include payoutFailurePayoutId.");
    expect(result.errors).toContain("Stripe money operations must include paymentProviderEventIds.");
    expect(result.errors).toContain("Stripe money operations must include connectProviderEventIds.");
    expect(result.errors).toContain("Stripe money operations must include paymentProviderEventQueryReference.");
    expect(result.errors).toContain("Stripe money operations must include connectProviderEventQueryReference.");
    expect(result.errors).toContain("Stripe money operations must include liveCheckoutReference.");
    expect(result.errors).toContain("Stripe money operations must include refundReference.");
    expect(result.errors).toContain("Stripe money operations must include payoutFailureReversalReference.");
    expect(result.errors).toContain("Stripe money operations must include radarRiskPostureReference.");
  });

  it("fails when Stripe proof omits provider webhook event row evidence", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          stripeMoneyOperations: {
            ...validPacket().gates.stripeMoneyOperations,
            paymentProviderEventRowCount: 4,
            connectProviderEventRowCount: 1,
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Stripe money operations must include paymentProviderEventRowCount of at least 5.");
    expect(result.errors).toContain("Stripe money operations must include connectProviderEventRowCount of at least 2.");
  });

  it("fails when Stripe money operations omit concrete live Stripe object ids", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          stripeMoneyOperations: {
            ...validPacket().gates.stripeMoneyOperations,
            livePaymentIntentId: "sample",
            refundId: "pi_liveRefund20260530",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Stripe money operations livePaymentIntentId must be a concrete Stripe identifier starting with pi_.",
    );
    expect(result.errors).toContain(
      "Stripe money operations refundId must be a concrete Stripe identifier starting with re_.",
    );
  });

  it("fails when Stripe money operations omit concrete provider event ids", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          stripeMoneyOperations: {
            ...validPacket().gates.stripeMoneyOperations,
            paymentProviderEventIds: [
              "evt_paymentCheckout2026053001",
              "evt_paymentCheckout2026053001",
              "evt_paymentRefund2026053003",
              "evt_sample",
            ],
            connectProviderEventIds: ["evt_connectAccount2026053001"],
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Stripe money operations paymentProviderEventIds must include at least 5 concrete Stripe event IDs.",
    );
    expect(result.errors).toContain(
      "Stripe money operations paymentProviderEventIds must not contain duplicate Stripe event IDs.",
    );
    expect(result.errors).toContain(
      "Stripe money operations paymentProviderEventIds entries must be concrete Stripe identifiers starting with evt_.",
    );
    expect(result.errors).toContain(
      "Stripe money operations connectProviderEventIds must include at least 2 concrete Stripe event IDs.",
    );
  });

  it("fails when Stripe proof uses non-production or mismatched callback URLs", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          stripeMoneyOperations: {
            ...validPacket().gates.stripeMoneyOperations,
            paymentWebhookDestination: "https://staging.chasesets.com/api/payments/provider/webhooks",
            connectWebhookDestination: "https://marketplace.chasesets.com/api/payments/provider/webhooks",
            connectPayoutSetupPageUrl: "https://marketplace.chasesets.com/checkout",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Stripe money operations paymentWebhookDestination must use /api/payments/provider/webhooks on a production Chase Sets host.",
    );
    expect(result.errors).toContain(
      "Stripe money operations connectWebhookDestination must use /api/settlement/provider/money-movement/webhooks on a production Chase Sets host.",
    );
    expect(result.errors).toContain(
      "Stripe money operations connectPayoutSetupPageUrl must use /account/payouts/setup on a production Chase Sets host.",
    );
  });

  it("fails when Custom Connect embedded setup proof is missing, stale, or hosted-dashboard shaped", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          stripeMoneyOperations: {
            ...validPacket().gates.stripeMoneyOperations,
            connectEmbeddedSetupSessionCreated: false,
            connectPayoutSetupPageEvidenceKind: "hosted-dashboard",
            connectEmbeddedSetupSessionCount: 1,
            connectCustomAccountProofCompletedAt: "2026-04-15T10:20:00.000Z",
            connectDashboardAccess: "express",
            connectControllerFeesPayer: "account",
            connectControllerLossesCollector: "stripe",
            connectControllerRequirementCollection: "stripe",
            sensitiveProviderDataStoredCount: 1,
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Stripe money operations must have connectEmbeddedSetupSessionCreated=true.");
    expect(result.errors).toContain(
      "Stripe money operations connectPayoutSetupPageEvidenceKind must be screenshot or redacted-run-output.",
    );
    expect(result.errors).toContain(
      "Stripe money operations connectCustomAccountProofCompletedAt cannot be older than 30 days.",
    );
    expect(result.errors).toContain("Stripe money operations must include at least two fresh embedded setup sessions.");
    expect(result.errors).toContain("Stripe money operations connectDashboardAccess must be none for Custom accounts.");
    expect(result.errors).toContain("Stripe money operations connectControllerFeesPayer must be application.");
    expect(result.errors).toContain("Stripe money operations connectControllerLossesCollector must be application.");
    expect(result.errors).toContain(
      "Stripe money operations connectControllerRequirementCollection must be application.",
    );
    expect(result.errors).toContain(
      "Stripe money operations must not store raw sensitive provider data in Chase Sets.",
    );
  });

  it("fails when Stripe proof is not live mode or uses the wrong API version", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          stripeMoneyOperations: {
            ...validPacket().gates.stripeMoneyOperations,
            environment: "test",
            apiVersion: "2025-09-30.clover",
            connectConnectedAccountCount: 0,
            proofCompletedAt: "2026-04-15T10:25:00.000Z",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Stripe money operations environment must be live.");
    expect(result.errors).toContain("Stripe money operations apiVersion must be 2026-03-25.dahlia.");
    expect(result.errors).toContain("Stripe money operations must include at least one live connected account.");
    expect(result.errors).toContain("Stripe money operations proofCompletedAt cannot be older than 30 days.");
  });

  it("fails when Stripe money operations omit proof completion timestamp", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          stripeMoneyOperations: {
            ...validPacket().gates.stripeMoneyOperations,
            proofCompletedAt: "",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Stripe money operations must include proofCompletedAt.");
  });

  it("fails when support operations omit concrete request and cross-context references", () => {
    const base = validPacket();
    const missingReference = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          supportOperations: {
            ...base.gates.supportOperations,
            refundEffectId: "",
            refundEffectReference: "",
            settlementHoldId: "",
            settlementHoldReleaseReference: "",
          },
        },
      }),
      { now },
    );

    expect(missingReference.ok).toBe(false);
    expect(missingReference.errors).toContain("Support operations must include refundEffectId.");
    expect(missingReference.errors).toContain("Support operations must include refundEffectReference.");
    expect(missingReference.errors).toContain("Support operations must include settlementHoldId.");
    expect(missingReference.errors).toContain("Support operations must include settlementHoldReleaseReference.");

    const placeholderIds = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          supportOperations: {
            ...base.gates.supportOperations,
            buyerSupportRequestId: "todo",
            refundResolutionSupportRequestId: "todo",
            refundId: "record",
            settlementHoldId: "ticket",
          },
        },
      }),
      { now },
    );

    expect(placeholderIds.ok).toBe(false);
    expect(placeholderIds.errors).toContain(
      "Support operations buyerSupportRequestId must be a concrete identifier, not a placeholder.",
    );
    expect(placeholderIds.errors).toContain(
      "Support operations refundResolutionSupportRequestId must be a concrete identifier, not a placeholder.",
    );
    expect(placeholderIds.errors).toContain(
      "Support operations refundId must be a concrete identifier, not a placeholder.",
    );
    expect(placeholderIds.errors).toContain(
      "Support operations settlementHoldId must be a concrete identifier, not a placeholder.",
    );

    const wrongPrefixes = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          supportOperations: {
            ...base.gates.supportOperations,
            buyerSupportRequestId: "req_buyer_rehearsal_20260530",
            refundResolutionSupportRequestId: "req_buyer_rehearsal_20260530",
            refundEffectId: "refund_effect_rehearsal_20260530",
            refundId: "refund_rehearsal_20260530",
            settlementHoldId: "settlement_hold_rehearsal_20260530",
          },
        },
      }),
      { now },
    );

    expect(wrongPrefixes.ok).toBe(false);
    expect(wrongPrefixes.errors).toContain("Support operations buyerSupportRequestId must start with sup_.");
    expect(wrongPrefixes.errors).toContain("Support operations refundResolutionSupportRequestId must start with sup_.");
    expect(wrongPrefixes.errors).toContain("Support operations refundEffectId must start with sre_.");
    expect(wrongPrefixes.errors).toContain("Support operations refundId must start with rfd_.");
    expect(wrongPrefixes.errors).toContain("Support operations settlementHoldId must start with hold_.");

    const invalidLifecycle = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          supportOperations: {
            ...base.gates.supportOperations,
            sellerSupportRequestId: "sup_buyer_rehearsal_20260530",
            refundResolutionSupportRequestId: "sup_other_rehearsal_20260530",
          },
        },
      }),
      { now },
    );

    expect(invalidLifecycle.ok).toBe(false);
    expect(invalidLifecycle.errors).toContain(
      "Support operations must include separate buyer and seller support request ids.",
    );
    expect(invalidLifecycle.errors).toContain(
      "Support operations refund resolution must be tied to the buyer support request id.",
    );

    const reusedSettlementEvidence = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          supportOperations: {
            ...base.gates.supportOperations,
            settlementHoldReleaseReference: "SETTLEMENT-SUPPORT-HOLD-2026-05-30",
          },
        },
      }),
      { now },
    );

    expect(reusedSettlementEvidence.ok).toBe(false);
    expect(reusedSettlementEvidence.errors).toContain(
      "Support operations must include separate hold and hold-release evidence references.",
    );

    const invalidEnvironment = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          supportOperations: {
            ...base.gates.supportOperations,
            environment: "production",
            rehearsalReference: "",
            rehearsalCompletedAt: "2026-04-15T10:45:00.000Z",
          },
        },
      }),
      { now },
    );

    expect(invalidEnvironment.ok).toBe(false);
    expect(invalidEnvironment.errors).toContain("Support operations environment must be staging.");
    expect(invalidEnvironment.errors).toContain("Support operations must include rehearsalReference.");
    expect(invalidEnvironment.errors).toContain(
      "Support operations rehearsalCompletedAt cannot be older than 30 days.",
    );
  });

  it("fails when Support operations omit the rehearsal completion timestamp", () => {
    const base = validPacket();
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          supportOperations: {
            ...base.gates.supportOperations,
            rehearsalCompletedAt: "",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Support operations must include rehearsalCompletedAt.");
  });

  it("fails when Fulfillment postage proof omits provider webhook ingestion evidence", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          fulfillmentPostage: {
            ...validPacket().gates.fulfillmentPostage,
            webhookDestinationConfigured: false,
            providerEventRowsProven: false,
            providerEventRowCount: 0,
            matchedShipmentProviderEventRowCount: 0,
            trackingStatusProviderEventRowCount: 0,
            refundStatusProviderEventRowCount: 0,
            parcelLabelReference: "",
            proofCompletedAt: "2026-04-15T10:35:00.000Z",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Fulfillment postage must have webhookDestinationConfigured=true.");
    expect(result.errors).toContain("Fulfillment postage must have providerEventRowsProven=true.");
    expect(result.errors).toContain("Fulfillment postage must include providerEventRowCount of at least 4.");
    expect(result.errors).toContain(
      "Fulfillment postage must include matchedShipmentProviderEventRowCount of at least 4.",
    );
    expect(result.errors).toContain(
      "Fulfillment postage must include trackingStatusProviderEventRowCount of at least 3.",
    );
    expect(result.errors).toContain(
      "Fulfillment postage must include refundStatusProviderEventRowCount of at least 1.",
    );
    expect(result.errors).toContain("Fulfillment postage must include parcelLabelReference.");
    expect(result.errors).toContain("Fulfillment postage proofCompletedAt cannot be older than 30 days.");
  });

  it("fails when Fulfillment postage omits proof completion timestamp", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          fulfillmentPostage: {
            ...validPacket().gates.fulfillmentPostage,
            proofCompletedAt: "",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Fulfillment postage must include proofCompletedAt.");
  });

  it("fails when Fulfillment postage proof omits concrete EasyPost object and event ids", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          fulfillmentPostage: {
            ...validPacket().gates.fulfillmentPostage,
            parcelProviderShipmentId: "sample",
            parcelProviderLabelId: "shp_wrongType20260530",
            trackingProviderObjectReference: "evt_wrongType20260530",
            providerEventIds: ["evt_trackingPreTransit20260530", "evt_trackingPreTransit20260530", "evt_sample"],
            trackingStatusProviderEventIds: ["evt_trackingPreTransit20260530", "event_trackingWrongPrefix20260530"],
            refundStatusProviderEventIds: [],
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Fulfillment postage parcelProviderShipmentId must be a concrete EasyPost identifier starting with shp_.",
    );
    expect(result.errors).toContain(
      "Fulfillment postage parcelProviderLabelId must be a concrete EasyPost identifier starting with pl_.",
    );
    expect(result.errors).toContain(
      "Fulfillment postage trackingProviderObjectReference must be a concrete EasyPost identifier starting with trk_.",
    );
    expect(result.errors).toContain(
      "Fulfillment postage providerEventIds must include at least 4 concrete EasyPost event IDs.",
    );
    expect(result.errors).toContain(
      "Fulfillment postage providerEventIds must not contain duplicate EasyPost event IDs.",
    );
    expect(result.errors).toContain(
      "Fulfillment postage providerEventIds entries must be concrete EasyPost event IDs starting with evt_.",
    );
    expect(result.errors).toContain(
      "Fulfillment postage trackingStatusProviderEventIds must include at least 3 concrete EasyPost event IDs.",
    );
    expect(result.errors).toContain(
      "Fulfillment postage trackingStatusProviderEventIds entries must be concrete EasyPost event IDs starting with evt_.",
    );
    expect(result.errors).toContain(
      "Fulfillment postage refundStatusProviderEventIds must include at least 1 concrete EasyPost event IDs.",
    );
  });

  it("accepts Fulfillment rehearsal evidence for the delivery exception path", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          fulfillmentPostage: {
            ...validPacket().gates.fulfillmentPostage,
            deliveryExceptionEvidenceKind: "fulfillment-rehearsal",
            deliveryExceptionProviderEventId: undefined,
            deliveryExceptionRehearsalShipmentId: "shp_rehearsedException20260530",
            deliveryExceptionReference: "FULFILLMENT-DELIVERY-EXCEPTION-REHEARSAL-2026-05-30",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(true);
  });

  it("fails when Fulfillment rehearsal delivery exception proof lacks a concrete shipment id", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          fulfillmentPostage: {
            ...validPacket().gates.fulfillmentPostage,
            deliveryExceptionEvidenceKind: "fulfillment-rehearsal",
            deliveryExceptionProviderEventId: undefined,
            deliveryExceptionRehearsalShipmentId: "placeholder",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Fulfillment postage deliveryExceptionRehearsalShipmentId must be a concrete identifier, not a placeholder.",
    );
  });

  it("fails when Fulfillment postage proof is not production EasyPost on the provider callback path", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          fulfillmentPostage: {
            ...validPacket().gates.fulfillmentPostage,
            environment: "staging",
            easyPostMode: "test",
            webhookDestination: "https://staging.chasesets.com/api/fulfillment/provider/postage/webhooks",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Fulfillment postage environment must be production.");
    expect(result.errors).toContain("Fulfillment postage easyPostMode must be production.");
    expect(result.errors).toContain(
      "Fulfillment postage webhookDestination must use /api/fulfillment/provider/postage/webhooks on a production Chase Sets host.",
    );
  });

  it("fails when transactional email template coverage omits a critical area", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          transactionalEmail: {
            ...validPacket().gates.transactionalEmail,
            criticalTemplateAreasCovered: ["auth", "orders", "payments", "fulfillment", "refunds", "support"],
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Transactional email criticalTemplateAreasCovered must include payouts.");
  });

  it("fails when transactional email omits provider event and proof references", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          transactionalEmail: {
            ...validPacket().gates.transactionalEmail,
            providerEventRowCount: 2,
            bounceEventReference: "",
            snsSubscriptionConfirmationReference: "",
            snsSubscriptionConfirmed: false,
            proofCompletedAt: "2026-04-15T10:40:00.000Z",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Transactional email must include providerEventRowCount of at least 3.");
    expect(result.errors).toContain("Transactional email must include bounceEventReference.");
    expect(result.errors).toContain("Transactional email must include snsSubscriptionConfirmationReference.");
    expect(result.errors).toContain("Transactional email must have snsSubscriptionConfirmed=true.");
    expect(result.errors).toContain("Transactional email proofCompletedAt cannot be older than 30 days.");
  });

  it("fails when transactional email omits concrete provider message and event ids", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          transactionalEmail: {
            ...validPacket().gates.transactionalEmail,
            controlledSendProviderMessageId: "sample",
            outboxRowId: "0",
            deliveryProviderEventId: "amazon-ses:ses_msg_controlled_20260530:bounce:2026-05-30T10:51:00.000Z",
            bounceProviderEventId: "amazon-ses:sample:bounce:2026-05-30T10:52:00.000Z",
            complaintProviderEventId: "amazon-ses:ses_msg_complaint_20260530:complaint:2026-05-30",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Transactional email controlledSendProviderMessageId must be a concrete identifier, not a placeholder.",
    );
    expect(result.errors).toContain("Transactional email outboxRowId must be a positive notification_outbox row id.");
    expect(result.errors).toContain("Transactional email deliveryProviderEventId must be a delivery provider event.");
    expect(result.errors).toContain(
      "Transactional email bounceProviderEventId provider message id must be a concrete identifier, not a placeholder.",
    );
    expect(result.errors).toContain(
      "Transactional email complaintProviderEventId occurred-at value must be an ISO timestamp.",
    );
  });

  it("fails when transactional email omits proof completion timestamp", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          transactionalEmail: {
            ...validPacket().gates.transactionalEmail,
            proofCompletedAt: "",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Transactional email must include proofCompletedAt.");
  });

  it("fails when transactional email proof is not production SES on the provider callback path", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          transactionalEmail: {
            ...validPacket().gates.transactionalEmail,
            environment: "staging",
            sesConfigurationSetName: "transactional-staging",
            webhookDestination: "https://staging.chasesets.com/api/notifications/provider/email/webhooks",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Transactional email environment must be production.");
    expect(result.errors).toContain("Transactional email sesConfigurationSetName must be transactional-production.");
    expect(result.errors).toContain(
      "Transactional email webhookDestination must use /api/notifications/provider/email/webhooks on a production Chase Sets host.",
    );
  });

  it("rejects UCP/AP2 public claims without certification", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          ucpAp2Marketing: {
            owner: "Checkout and Payments",
            publicLaunchClaimsEnabled: true,
            certificationApproved: false,
            certificationReference: "",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("UCP/AP2 public launch claims require certificationApproved=true.");
  });

  it("requires UCP/AP2 copy review evidence when public claims are disabled", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          ucpAp2Marketing: {
            owner: "Checkout and Payments",
            publicLaunchClaimsEnabled: false,
            certificationApproved: false,
            certificationReference: "",
            claimsReviewReference: "",
            uncertifiedClaimsAbsent: false,
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("UCP/AP2 marketing must include claimsReviewReference.");
    expect(result.errors).toContain(
      "UCP/AP2 launch restraint requires uncertifiedClaimsAbsent=true when public claims are disabled.",
    );
  });

  it("rejects placeholder UCP/AP2 certification references", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        gates: {
          ucpAp2Marketing: {
            ...validPacket().gates.ucpAp2Marketing,
            certificationApproved: true,
            certificationReference: "todo",
          },
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "UCP/AP2 certification reference must point to a real external evidence record, not a placeholder.",
    );
  });

  it("requires explicit UCP/AP2 marketing evidence", () => {
    const base = validPacket();
    const { ucpAp2Marketing: _ucpAp2Marketing, ...gates } = base.gates;
    const result = validateMarketplaceLaunchEvidence({ ...base, gates }, { now });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("UCP/AP2 marketing gate is required so public launch claims remain explicit.");
  });

  it("rejects GitHub Environment reference drift", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        productionEnvironment: {
          PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE: "WRONG-REFERENCE-2026-05-30",
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE must match the gate reference.");
  });

  it("requires a real Marketplace Launch Evidence packet reference in productionEnvironment", () => {
    const result = validateMarketplaceLaunchEvidence(
      validPacket({
        productionEnvironment: {
          PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE: "placeholder",
        },
      }),
      { now },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE must point to a real external evidence record, not a placeholder.",
    );
  });

  it("requires productionEnvironment for GitHub Environment comparison", () => {
    const packet = validPacket();
    const { productionEnvironment: _productionEnvironment, ...withoutProductionEnvironment } = packet;
    const result = validateMarketplaceLaunchEvidence(withoutProductionEnvironment, { now });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "productionEnvironment is required so packet gates can be compared to GitHub Environment values.",
    );
  });
});
