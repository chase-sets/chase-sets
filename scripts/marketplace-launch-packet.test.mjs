import { describe, expect, it } from "vitest";
import {
  buildDesiredProductionEnvironment,
  buildLaunchPacket,
  parseLaunchPacketArgs,
} from "./marketplace-launch-packet.mjs";
import {
  MARKETPLACE_LAUNCH_EVIDENCE_SCHEMA_VERSION,
  validateMarketplaceLaunchEvidence,
} from "./marketplace-launch-evidence.mjs";

const checkedAt = "2026-05-30T11:00:00.000Z";
const now = new Date("2026-05-30T12:00:00.000Z");

function gate(reference, owner) {
  return {
    approved: true,
    reference,
    owner,
    checkedAt,
  };
}

function validInputs(overrides = {}) {
  const productionEnvironment = {
    PRODUCTION_MARKETPLACE_PUBLIC_ENABLED: "false",
    PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE: "MARKETPLACE-LAUNCH-EVIDENCE-2026-05-30",
    PRODUCTION_MARKETPLACE_PROOF_ENABLED: "false",
    PRODUCTION_MARKETPLACE_PROOF_REFERENCE: "",
    PRODUCTION_MARKETPLACE_PROMOTION_APPROVED: "true",
    PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE: "LAUNCH-REVIEW-2026-05-30",
    PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED: "true",
    PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE: "PAYMENTS-FEE-2026-05-30",
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
    EASYPOST_MODE: "production",
  };

  const inputs = {
    productionEnvironment,
    promotion: {
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
      ucpAp2Marketing: {
        owner: "Checkout and Payments",
        publicLaunchClaimsEnabled: false,
        certificationApproved: false,
        certificationReference: "",
        claimsReviewReference: "ucp-ap2-copy-review-2026-05-30",
        uncertifiedClaimsAbsent: true,
      },
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
    stripeMoneyOperations: {
      ...gate("STRIPE-MONEY-2026-05-30", "Payments and Settlement"),
      proofReference: "STRIPE-MONEY-PROOF-2026-05-30",
      proofCompletedAt: "2026-05-30T10:25:00.000Z",
      environment: "live",
      releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
      apiVersion: "2026-03-25.dahlia",
      paymentWebhookDestination: "https://chasesets.com/api/payments/provider/webhooks",
      connectWebhookDestination: "https://chasesets.com/api/settlement/provider/money-movement/webhooks",
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
      queryVersion: "launch-supply-measurement-query/v1",
      checkedAt,
      environment: "production",
      queryReference: "CATALOG-LAUNCH-SUPPLY-QUERY-2026-05-30",
      operator: "ops@chasesets.com",
      projectionFreshnessReference: "projection-freshness-2026-05-30",
      activeLaunchListingCount: 42,
      activeLaunchSellerAccountCount: 7,
      sampledActiveLaunchListingIds: ["lst_1", "lst_2", "lst_3"],
      activeLaunchListingsMissingResolvedProductMeasures: 0,
      resolvedProductMeasureCoveragePercent: 100,
      passesLaunchSupplyGate: true,
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
  };

  return {
    ...inputs,
    ...overrides,
    productionEnvironment: {
      ...inputs.productionEnvironment,
      ...(overrides.productionEnvironment ?? {}),
    },
  };
}

describe("marketplace launch packet assembly", () => {
  it("assembles helper outputs into a launch verifier packet", () => {
    const packet = buildLaunchPacket(validInputs(), { launchSupplyOwner: "Catalog" });
    const result = validateMarketplaceLaunchEvidence(packet, { now });

    expect(packet.schemaVersion).toBe(MARKETPLACE_LAUNCH_EVIDENCE_SCHEMA_VERSION);
    expect(packet.gates.marketplacePromotion.reference).toBe("LAUNCH-REVIEW-2026-05-30");
    expect(packet.gates.launchSupplyMeasurements).toMatchObject({
      approved: true,
      reference: "CATALOG-MEASURES-2026-05-30",
      owner: "Catalog",
      activeLaunchListingCount: 42,
      activeLaunchSellerAccountCount: 7,
      sampledActiveLaunchListingIds: ["lst_1", "lst_2", "lst_3"],
    });
    expect(result).toMatchObject({ ok: true, errors: [] });
  });

  it("normalizes a failing launch supply measurement into a failing launch packet gate", () => {
    const packet = buildLaunchPacket(
      validInputs({
        launchSupplyMeasurements: {
          ...validInputs().launchSupplyMeasurements,
          activeLaunchListingsMissingResolvedProductMeasures: 1,
          passesLaunchSupplyGate: false,
        },
      }),
      { launchSupplyOwner: "Catalog" },
    );
    const result = validateMarketplaceLaunchEvidence(packet, { now });

    expect(packet.gates.launchSupplyMeasurements.approved).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Launch supply measurements gate must have approved=true.");
  });

  it("can assemble the desired productionEnvironment from gate outputs before GitHub variables are set", () => {
    const { productionEnvironment: _productionEnvironment, ...inputsWithoutEnvironment } = validInputs();
    const packet = buildLaunchPacket(inputsWithoutEnvironment, {
      launchSupplyOwner: "Catalog",
      launchSupplyReference: "CATALOG-MEASURES-2026-05-30",
      publicEnabled: "true",
      launchEvidenceReference: "MARKETPLACE-LAUNCH-EVIDENCE-2026-05-30",
    });
    const result = validateMarketplaceLaunchEvidence(packet, { now });

    expect(packet.productionEnvironment).toMatchObject({
      PRODUCTION_MARKETPLACE_PUBLIC_ENABLED: "true",
      PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE: "MARKETPLACE-LAUNCH-EVIDENCE-2026-05-30",
      PRODUCTION_MARKETPLACE_PROMOTION_APPROVED: "true",
      PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE: "LAUNCH-REVIEW-2026-05-30",
      PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE: "CATALOG-MEASURES-2026-05-30",
      TAX_PROVIDER_BACKED_QUOTES_REQUIRED: "false",
      EASYPOST_MODE: "production",
      PRODUCTION_MARKETPLACE_PROOF_ENABLED: "false",
    });
    expect(result).toMatchObject({ ok: true, errors: [] });
  });

  it("requires launch evidence and launch supply references when deriving desired productionEnvironment", () => {
    const { productionEnvironment: _productionEnvironment, ...inputsWithoutEnvironment } = validInputs();

    expect(() => buildLaunchPacket(inputsWithoutEnvironment, { launchSupplyOwner: "Catalog" })).toThrow(
      "Marketplace launch packet assembly requires --launch-supply-reference when --production-env is omitted.",
    );
    expect(() =>
      buildLaunchPacket(inputsWithoutEnvironment, {
        launchSupplyOwner: "Catalog",
        launchSupplyReference: "CATALOG-MEASURES-2026-05-30",
      }),
    ).toThrow("--launch-evidence-reference must be a non-empty evidence reference.");
  });

  it("builds desired productionEnvironment values directly from gates", () => {
    const inputs = validInputs();

    expect(
      buildDesiredProductionEnvironment(
        {
          marketplacePromotion: inputs.promotion.marketplacePromotion,
          marketplaceCheckoutFee: inputs.marketplaceCheckoutFee,
          stripeMoneyOperations: inputs.stripeMoneyOperations,
          supportOperations: inputs.supportOperations,
          fulfillmentPostage: inputs.fulfillmentPostage,
          transactionalEmail: inputs.transactionalEmail,
          launchSupplyMeasurements: inputs.launchSupplyMeasurements,
          taxReadiness: inputs.taxReadiness,
        },
        {
          launchSupplyReference: "CATALOG-MEASURES-2026-05-30",
          launchEvidenceReference: "MARKETPLACE-LAUNCH-EVIDENCE-2026-05-30",
          proofEnabled: true,
          proofReference: "PRODUCTION-PROOF-2026-05-30",
        },
      ),
    ).toMatchObject({
      PRODUCTION_MARKETPLACE_PUBLIC_ENABLED: "false",
      PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE: "MARKETPLACE-LAUNCH-EVIDENCE-2026-05-30",
      PRODUCTION_MARKETPLACE_PROOF_ENABLED: "true",
      PRODUCTION_MARKETPLACE_PROOF_REFERENCE: "PRODUCTION-PROOF-2026-05-30",
      PRODUCTION_SUPPORT_OPERATIONS_REFERENCE: "SUPPORT-OPS-2026-05-30",
      EASYPOST_MODE: "production",
    });
  });

  it("refuses to assemble launch variables from non-production EasyPost proof", () => {
    const inputs = validInputs({
      fulfillmentPostage: {
        ...validInputs().fulfillmentPostage,
        easyPostMode: "test",
      },
    });

    expect(() =>
      buildDesiredProductionEnvironment(
        {
          marketplacePromotion: inputs.promotion.marketplacePromotion,
          marketplaceCheckoutFee: inputs.marketplaceCheckoutFee,
          stripeMoneyOperations: inputs.stripeMoneyOperations,
          supportOperations: inputs.supportOperations,
          fulfillmentPostage: inputs.fulfillmentPostage,
          transactionalEmail: inputs.transactionalEmail,
          launchSupplyMeasurements: inputs.launchSupplyMeasurements,
          taxReadiness: inputs.taxReadiness,
        },
        {
          launchSupplyReference: "CATALOG-MEASURES-2026-05-30",
          launchEvidenceReference: "MARKETPLACE-LAUNCH-EVIDENCE-2026-05-30",
        },
      ),
    ).toThrow("fulfillmentPostage.easyPostMode must be production for marketplace launch packet assembly.");
  });

  it("resolves required input paths from flags and environment", () => {
    expect(
      parseLaunchPacketArgs(
        [
          "--production-env",
          "env.json",
          "--promotion",
          "promotion.json",
          "--launch-supply-owner",
          "Catalog Ops",
          "--launch-evidence-reference",
          "MARKETPLACE-LAUNCH-EVIDENCE-2026-05-30",
          "--public-enabled",
          "true",
        ],
        {
          MARKETPLACE_CHECKOUT_FEE_EVIDENCE: "fee.json",
          STRIPE_MONEY_OPERATIONS_EVIDENCE: "stripe.json",
          SUPPORT_OPERATIONS_EVIDENCE: "support.json",
          FULFILLMENT_POSTAGE_EVIDENCE: "postage.json",
          TRANSACTIONAL_EMAIL_EVIDENCE: "email.json",
          LAUNCH_SUPPLY_MEASUREMENT_EVIDENCE: "supply.json",
          TAX_READINESS_EVIDENCE: "tax.json",
        },
      ),
    ).toMatchObject({
      productionEnvironmentPath: "env.json",
      promotionPath: "promotion.json",
      publicEnabled: "true",
      checkoutFeePath: "fee.json",
      stripeMoneyPath: "stripe.json",
      supportPath: "support.json",
      fulfillmentPostagePath: "postage.json",
      transactionalEmailPath: "email.json",
      launchSupplyPath: "supply.json",
      taxReadinessPath: "tax.json",
      launchSupplyOwner: "Catalog Ops",
      launchEvidenceReference: "MARKETPLACE-LAUNCH-EVIDENCE-2026-05-30",
    });
  });
});
