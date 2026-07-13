import { describe, expect, it } from "vitest";
import {
  MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
  REQUIRED_PUBLIC_PRESENCE_PAGES,
} from "./marketplace-public-presence-copy-audit.mjs";
import {
  MARKETPLACE_PROMOTION_EVIDENCE_VERSION,
  REQUIRED_MARKETPLACE_PROMOTION_PROOFS,
  buildPromotionEvidence,
  parsePromotionEvidenceArgs,
} from "./marketplace-promotion-evidence.mjs";

function review(overrides = {}) {
  return {
    reviewReference: "LAUNCH-REVIEW-PROOF-2026-05-30",
    reviewCompletedAt: "2026-05-30T13:45:00.000Z",
    environment: "production",
    releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
    stagingWorkflowRunReference: "platform-deploy-staging-26688444710",
    productionWorkflowRunReference: "platform-deploy-production-26688444710",
    checkoutLaunchEvidenceReference: "CHECKOUT-LAUNCH-2026-05-30",
    checkoutLaunchEvidenceCompletedAt: "2026-05-30T13:20:00.000Z",
    publicPresenceReviewReference: "PUBLIC-PRESENCE-2026-05-30",
    publicPresenceCopyAuditReference: "PUBLIC-PRESENCE-COPY-AUDIT-2026-05-30",
    publicPresenceCopyAuditVersion: MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
    publicPresenceCopyAuditBaseUrl: "https://chasesets.com",
    publicPresenceCopyAuditCompletedAt: "2026-05-30T13:30:00.000Z",
    publicPresenceCopyAuditMode: "launch",
    publicPresenceCopyAuditRequiredPageCount: REQUIRED_PUBLIC_PRESENCE_PAGES.length,
    publicPresenceCopyAuditPassed: true,
    publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved: true,
    publicPresenceCopyAuditPolicyPagesReviewed: true,
    publicPresenceCopyAuditUncertifiedClaimsAbsent: true,
    policyPagesReviewReference: "PUBLIC-POLICIES-2026-05-30",
    rollbackOwnerReference: "ROLLBACK-OWNER-2026-05-30",
    finalLaunchReviewApproved: true,
    checkoutLaunchEvidenceApproved: true,
    checkoutLaunchBuyNowBuyCartSellListReviewed: true,
    checkoutLaunchGuestAndSignedInReviewed: true,
    checkoutLaunchDesktopMobileAccessibilityReviewed: true,
    checkoutLaunchNoPreConfirmationSideEffects: true,
    checkoutLaunchObservabilitySupportSecurityHandoffsReviewed: true,
    checkoutLaunchFulfillmentAssignmentBeforeSessionReviewed: true,
    checkoutLaunchFreshStateCleanupReviewed: true,
    checkoutLaunchNoLegacyCompatibilityPaths: true,
    publicPresenceLaunchCopyReviewed: true,
    futureOnlyLaunchCopyRemoved: true,
    policyPagesReviewed: true,
    rollbackOwnerAssigned: true,
    ucpAp2Owner: "Checkout and Payments",
    publicLaunchClaimsEnabled: false,
    certificationApproved: false,
    certificationReference: "",
    ucpAp2ClaimsReviewReference: "UCP-AP2-CLAIMS-REVIEW-2026-05-30",
    uncertifiedClaimsAbsent: true,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    review: review(),
    reference: "LAUNCH-REVIEW-2026-05-30",
    owner: "Platform Operations",
    checkedAt: "2026-05-30T14:00:00.000Z",
    ...overrides,
  };
}

describe("marketplace promotion evidence", () => {
  it("builds the marketplace promotion and UCP/AP2 gates from a complete review", () => {
    expect(buildPromotionEvidence(input())).toEqual({
      schemaVersion: MARKETPLACE_PROMOTION_EVIDENCE_VERSION,
      passesPromotionGate: true,
      marketplacePromotion: {
        approved: true,
        reference: "LAUNCH-REVIEW-2026-05-30",
        owner: "Platform Operations",
        checkedAt: "2026-05-30T14:00:00.000Z",
        reviewReference: "LAUNCH-REVIEW-PROOF-2026-05-30",
        reviewCompletedAt: "2026-05-30T13:45:00.000Z",
        environment: "production",
        releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
        stagingWorkflowRunReference: "platform-deploy-staging-26688444710",
        productionWorkflowRunReference: "platform-deploy-production-26688444710",
        checkoutLaunchEvidenceReference: "CHECKOUT-LAUNCH-2026-05-30",
        checkoutLaunchEvidenceCompletedAt: "2026-05-30T13:20:00.000Z",
        publicPresenceReviewReference: "PUBLIC-PRESENCE-2026-05-30",
        publicPresenceCopyAuditReference: "PUBLIC-PRESENCE-COPY-AUDIT-2026-05-30",
        publicPresenceCopyAuditVersion: MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
        publicPresenceCopyAuditBaseUrl: "https://chasesets.com",
        publicPresenceCopyAuditCompletedAt: "2026-05-30T13:30:00.000Z",
        publicPresenceCopyAuditMode: "launch",
        publicPresenceCopyAuditRequiredPageCount: REQUIRED_PUBLIC_PRESENCE_PAGES.length,
        publicPresenceCopyAuditPassed: true,
        publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved: true,
        publicPresenceCopyAuditPolicyPagesReviewed: true,
        publicPresenceCopyAuditUncertifiedClaimsAbsent: true,
        policyPagesReviewReference: "PUBLIC-POLICIES-2026-05-30",
        rollbackOwnerReference: "ROLLBACK-OWNER-2026-05-30",
        finalLaunchReviewApproved: true,
        checkoutLaunchEvidenceApproved: true,
        checkoutLaunchBuyNowBuyCartSellListReviewed: true,
        checkoutLaunchGuestAndSignedInReviewed: true,
        checkoutLaunchDesktopMobileAccessibilityReviewed: true,
        checkoutLaunchNoPreConfirmationSideEffects: true,
        checkoutLaunchObservabilitySupportSecurityHandoffsReviewed: true,
        checkoutLaunchFulfillmentAssignmentBeforeSessionReviewed: true,
        checkoutLaunchFreshStateCleanupReviewed: true,
        checkoutLaunchNoLegacyCompatibilityPaths: true,
        publicPresenceLaunchCopyReviewed: true,
        futureOnlyLaunchCopyRemoved: true,
        policyPagesReviewed: true,
        rollbackOwnerAssigned: true,
      },
      ucpAp2Marketing: {
        owner: "Checkout and Payments",
        publicLaunchClaimsEnabled: false,
        certificationApproved: false,
        certificationReference: "",
        claimsReviewReference: "UCP-AP2-CLAIMS-REVIEW-2026-05-30",
        uncertifiedClaimsAbsent: true,
      },
    });
  });

  it("fails when required promotion proof is missing", () => {
    const evidence = buildPromotionEvidence(
      input({
        review: review({
          futureOnlyLaunchCopyRemoved: false,
        }),
      }),
    );

    expect(evidence.marketplacePromotion.approved).toBe(false);
    expect(evidence.errors).toContain("Marketplace promotion review must prove futureOnlyLaunchCopyRemoved=true.");
  });

  it("fails when detailed promotion references are placeholders", () => {
    const evidence = buildPromotionEvidence(
      input({
        review: review({
          publicPresenceReviewReference: "todo",
        }),
      }),
    );

    expect(evidence.passesPromotionGate).toBe(false);
    expect(evidence.errors).toContain(
      "Marketplace promotion publicPresenceReviewReference must point to a real external evidence record, not a placeholder.",
    );
  });

  it("fails when checkout launch evidence is missing from the final promotion review", () => {
    const evidence = buildPromotionEvidence(
      input({
        review: review({
          checkoutLaunchEvidenceApproved: false,
          checkoutLaunchEvidenceReference: "todo",
          checkoutLaunchBuyNowBuyCartSellListReviewed: false,
          checkoutLaunchGuestAndSignedInReviewed: false,
          checkoutLaunchDesktopMobileAccessibilityReviewed: false,
          checkoutLaunchNoPreConfirmationSideEffects: false,
          checkoutLaunchObservabilitySupportSecurityHandoffsReviewed: false,
          checkoutLaunchFulfillmentAssignmentBeforeSessionReviewed: false,
          checkoutLaunchFreshStateCleanupReviewed: false,
          checkoutLaunchNoLegacyCompatibilityPaths: false,
        }),
      }),
    );

    expect(evidence.passesPromotionGate).toBe(false);
    expect(evidence.errors).toContain("Marketplace promotion review must prove checkoutLaunchEvidenceApproved=true.");
    expect(evidence.errors).toContain(
      "Marketplace promotion checkoutLaunchEvidenceReference must point to a real external evidence record, not a placeholder.",
    );
    expect(evidence.errors).toContain(
      "Marketplace promotion review must prove checkoutLaunchBuyNowBuyCartSellListReviewed=true.",
    );
    expect(evidence.errors).toContain(
      "Marketplace promotion review must prove checkoutLaunchGuestAndSignedInReviewed=true.",
    );
    expect(evidence.errors).toContain(
      "Marketplace promotion review must prove checkoutLaunchDesktopMobileAccessibilityReviewed=true.",
    );
    expect(evidence.errors).toContain(
      "Marketplace promotion review must prove checkoutLaunchNoPreConfirmationSideEffects=true.",
    );
    expect(evidence.errors).toContain(
      "Marketplace promotion review must prove checkoutLaunchObservabilitySupportSecurityHandoffsReviewed=true.",
    );
    expect(evidence.errors).toContain(
      "Marketplace promotion review must prove checkoutLaunchFulfillmentAssignmentBeforeSessionReviewed=true.",
    );
    expect(evidence.errors).toContain(
      "Marketplace promotion review must prove checkoutLaunchFreshStateCleanupReviewed=true.",
    );
    expect(evidence.errors).toContain(
      "Marketplace promotion review must prove checkoutLaunchNoLegacyCompatibilityPaths=true.",
    );
  });

  it("fails when the Public Presence copy audit is not launch mode", () => {
    const evidence = buildPromotionEvidence(
      input({
        review: review({
          publicPresenceCopyAuditMode: "prelaunch",
        }),
      }),
    );

    expect(evidence.marketplacePromotion.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Marketplace promotion review must use a launch-mode Public Presence copy audit.",
    );
  });

  it("fails when the Public Presence copy audit summary is not the required production launch audit", () => {
    const evidence = buildPromotionEvidence(
      input({
        review: review({
          publicPresenceCopyAuditVersion: "copy-audit/v0",
          publicPresenceCopyAuditBaseUrl: "https://staging.chasesets.com",
          publicPresenceCopyAuditRequiredPageCount: REQUIRED_PUBLIC_PRESENCE_PAGES.length - 1,
          publicPresenceCopyAuditPassed: false,
          publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved: false,
          publicPresenceCopyAuditPolicyPagesReviewed: false,
          publicPresenceCopyAuditUncertifiedClaimsAbsent: false,
        }),
      }),
    );

    expect(evidence.marketplacePromotion.approved).toBe(false);
    expect(evidence.errors).toContain(
      `Marketplace promotion review must use ${MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION}.`,
    );
    expect(evidence.errors).toContain(
      "Marketplace promotion publicPresenceCopyAuditBaseUrl must use https://chasesets.com.",
    );
    expect(evidence.errors).toContain(
      `Marketplace promotion review must include publicPresenceCopyAuditRequiredPageCount=${REQUIRED_PUBLIC_PRESENCE_PAGES.length}.`,
    );
    expect(evidence.errors).toContain("Marketplace promotion review must prove publicPresenceCopyAuditPassed=true.");
    expect(evidence.errors).toContain(
      "Marketplace promotion review must prove publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved=true.",
    );
    expect(evidence.errors).toContain(
      "Marketplace promotion review must prove publicPresenceCopyAuditPolicyPagesReviewed=true.",
    );
    expect(evidence.errors).toContain(
      "Marketplace promotion review must prove publicPresenceCopyAuditUncertifiedClaimsAbsent=true.",
    );
  });

  it("fails when review is not production scoped", () => {
    const evidence = buildPromotionEvidence(
      input({
        review: review({
          environment: "staging",
        }),
      }),
    );

    expect(evidence.marketplacePromotion.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Marketplace promotion review must be production-scoped before marketplace launch.",
    );
  });

  it("fails when releaseCommit is not a 40-character Git commit SHA", () => {
    const evidence = buildPromotionEvidence(
      input({
        review: review({
          releaseCommit: "release-candidate",
        }),
      }),
    );

    expect(evidence.marketplacePromotion.approved).toBe(false);
    expect(evidence.errors).toContain("Marketplace promotion releaseCommit must be a 40-character Git commit SHA.");
  });

  it("fails when the launch review or copy audit is stale", () => {
    const evidence = buildPromotionEvidence(
      input({
        review: review({
          reviewCompletedAt: "2026-04-15T13:45:00.000Z",
          checkoutLaunchEvidenceCompletedAt: "2026-04-15T13:20:00.000Z",
          publicPresenceCopyAuditCompletedAt: "2026-04-15T13:30:00.000Z",
        }),
      }),
    );

    expect(evidence.marketplacePromotion.approved).toBe(false);
    expect(evidence.errors).toContain("Marketplace promotion reviewCompletedAt cannot be older than 30 days.");
    expect(evidence.errors).toContain(
      "Marketplace promotion checkoutLaunchEvidenceCompletedAt cannot be older than 30 days.",
    );
    expect(evidence.errors).toContain(
      "Marketplace promotion publicPresenceCopyAuditCompletedAt cannot be older than 30 days.",
    );
  });

  it("fails when launch review timestamps are date-only values", () => {
    const reviewCompletedOnly = buildPromotionEvidence(
      input({
        review: review({
          reviewCompletedAt: "2026-05-30",
        }),
      }),
    );
    const auditCompletedOnly = buildPromotionEvidence(
      input({
        review: review({
          publicPresenceCopyAuditCompletedAt: "2026-05-30",
        }),
      }),
    );
    const checkedOnly = buildPromotionEvidence(input({ checkedAt: "2026-05-30" }));

    expect(reviewCompletedOnly.passesPromotionGate).toBe(false);
    expect(reviewCompletedOnly.errors).toContain("Marketplace promotion reviewCompletedAt must be an ISO timestamp.");
    const checkoutEvidenceCompletedOnly = buildPromotionEvidence(
      input({
        review: review({
          checkoutLaunchEvidenceCompletedAt: "2026-05-30",
        }),
      }),
    );
    expect(auditCompletedOnly.passesPromotionGate).toBe(false);
    expect(checkoutEvidenceCompletedOnly.passesPromotionGate).toBe(false);
    expect(checkoutEvidenceCompletedOnly.errors).toContain(
      "Marketplace promotion checkoutLaunchEvidenceCompletedAt must be an ISO timestamp.",
    );
    expect(auditCompletedOnly.errors).toContain(
      "Marketplace promotion publicPresenceCopyAuditCompletedAt must be an ISO timestamp.",
    );
    expect(checkedOnly.passesPromotionGate).toBe(false);
    expect(checkedOnly.errors).toContain("Marketplace promotion evidence checkedAt must be an ISO timestamp.");
  });

  it("fails UCP/AP2 public launch claims without certification", () => {
    const evidence = buildPromotionEvidence(
      input({
        review: review({
          publicLaunchClaimsEnabled: true,
          certificationApproved: false,
          certificationReference: "",
        }),
      }),
    );

    expect(evidence.passesPromotionGate).toBe(false);
    expect(evidence.errors).toContain("UCP/AP2 public launch claims require certificationApproved=true.");
    expect(evidence.errors).toContain("UCP/AP2 public launch claims require a certificationReference.");
  });

  it("allows UCP/AP2 public launch claims with certification proof", () => {
    const evidence = buildPromotionEvidence(
      input({
        review: review({
          publicLaunchClaimsEnabled: true,
          certificationApproved: true,
          certificationReference: "UCP-AP2-CERTIFICATION-2026-05-30",
        }),
      }),
    );

    expect(evidence.passesPromotionGate).toBe(true);
    expect(evidence.ucpAp2Marketing).toMatchObject({
      publicLaunchClaimsEnabled: true,
      certificationApproved: true,
      certificationReference: "UCP-AP2-CERTIFICATION-2026-05-30",
    });
  });

  it("rejects placeholder UCP/AP2 certification references", () => {
    const evidence = buildPromotionEvidence(
      input({
        review: review({
          publicLaunchClaimsEnabled: true,
          certificationApproved: true,
          certificationReference: "todo",
        }),
      }),
    );

    expect(evidence.passesPromotionGate).toBe(false);
    expect(evidence.errors).toContain(
      "UCP/AP2 certificationReference must point to a real external evidence record, not a placeholder.",
    );
  });

  it("keeps the required proof list aligned with the launch evidence verifier", () => {
    expect(REQUIRED_MARKETPLACE_PROMOTION_PROOFS).toEqual([
      "finalLaunchReviewApproved",
      "checkoutLaunchEvidenceApproved",
      "checkoutLaunchBuyNowBuyCartSellListReviewed",
      "checkoutLaunchGuestAndSignedInReviewed",
      "checkoutLaunchDesktopMobileAccessibilityReviewed",
      "checkoutLaunchNoPreConfirmationSideEffects",
      "checkoutLaunchObservabilitySupportSecurityHandoffsReviewed",
      "checkoutLaunchFulfillmentAssignmentBeforeSessionReviewed",
      "checkoutLaunchFreshStateCleanupReviewed",
      "checkoutLaunchNoLegacyCompatibilityPaths",
      "publicPresenceLaunchCopyReviewed",
      "futureOnlyLaunchCopyRemoved",
      "policyPagesReviewed",
      "rollbackOwnerAssigned",
    ]);
  });

  it("parses operator arguments from flags and environment", () => {
    expect(
      parsePromotionEvidenceArgs(
        [
          "--review",
          "secure/promotion.json",
          "--reference",
          "LAUNCH-REVIEW-2026-05-30",
          "--owner",
          "Launch Ops",
          "--checked-at",
          "2026-05-30T14:00:00.000Z",
        ],
        {},
      ),
    ).toMatchObject({
      reviewPath: "secure/promotion.json",
      reference: "LAUNCH-REVIEW-2026-05-30",
      owner: "Launch Ops",
      checkedAt: "2026-05-30T14:00:00.000Z",
    });

    expect(
      parsePromotionEvidenceArgs([], {
        MARKETPLACE_PROMOTION_REVIEW_RECORD: "secure/promotion.json",
        PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE: "LAUNCH-REVIEW-2026-05-30",
      }),
    ).toMatchObject({
      reviewPath: "secure/promotion.json",
      reference: "LAUNCH-REVIEW-2026-05-30",
      owner: "Platform Operations",
    });
  });
});
