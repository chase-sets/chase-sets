import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildCounselReviewPacketReceipt,
  buildLegalReviewCorpus,
  loadLegalReviewAuthorities,
  renderCounselReviewPacket,
  renderCounselReviewPacketReceipt,
  resolveLegalReviewMembership,
} from "./legal-review-corpus.mjs";
import {
  MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
  REQUIRED_PUBLIC_PRESENCE_PAGES,
  REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS,
  auditPublicPresenceCopy,
} from "./marketplace-public-presence-copy-audit.mjs";
import {
  MARKETPLACE_PROMOTION_EVIDENCE_VERSION,
  REQUIRED_MARKETPLACE_PROMOTION_PROOFS,
  buildPromotionEvidence,
  parsePromotionEvidenceArgs,
  runPromotionEvidence,
  validatePromotionEvidenceOptions,
} from "./marketplace-promotion-evidence.mjs";
import {
  resolveCanonicalLegalCorpusMembership,
  validatePromotionLegalCorpusProjection,
} from "./launch-go-no-go-gate.mjs";

// Every case below holds ONE real successful launch-mode audit record fixed
// and mutates only the review or the audit input, so a passing result can only
// come from an audit that actually ran. The counsel disposition and Copyright
// Office record in the fixture corpus are unmistakably synthetic control
// tokens applied in memory.
const SYNTHETIC_COUNSEL_APPROVAL_REFERENCE = "SYNTHETIC-COUNSEL-DISPOSITION-CONTROL-0001";
const SYNTHETIC_DMCA_DIRECTORY_RECORD = "synthetic-directory-record-control";
const LAUNCH_BODY = "Live marketplace policies are available. Support is available.";
const PRELAUNCH_BODY =
  "Public marketplace checkout opens only after production promotion approval. Request early access.";
const CHECKED_AT = "2026-09-05T02:00:00.000Z";
const AUDIT_CHECKED_AT = "2026-09-05T01:30:00.000Z";

let successfulAudit;
let successfulPrelaunchAudit;
let canonicalMembership;
let temporaryDirectory;

beforeAll(async () => {
  const base = await loadLegalReviewAuthorities();
  const authorities = {
    ...base,
    policyRegistry: base.policyRegistry.map((entry) => ({
      ...entry,
      artifact: {
        ...entry.artifact,
        metadata: {
          ...entry.artifact.metadata,
          publicationStatus: "published",
          effectiveAt: "2026-09-01T00:00:00.000Z",
          counselApprovalReference: SYNTHETIC_COUNSEL_APPROVAL_REFERENCE,
          rolloutJurisdictionsOrProductLimits: ["synthetic-reviewed-rollout-scope"],
        },
        sections: entry.artifact.sections.map((section) => ({ ...section, reviewStatus: "counsel-approved" })),
      },
    })),
    helpArticleSources: base.helpArticleSources.map((source) =>
      source.fileName === "intellectual-property-and-dmca.en.md"
        ? {
            ...source,
            source: source.source.replaceAll(base.dmcaUnverifiedRegistrationMarker, SYNTHETIC_DMCA_DIRECTORY_RECORD),
          }
        : source,
    ),
  };
  const built = buildLegalReviewCorpus(authorities);
  if (!built.ok) {
    throw new Error(`expected a valid corpus, got: ${built.errors.join(" | ")}`);
  }

  temporaryDirectory = mkdtempSync(path.join(tmpdir(), "marketplace-promotion-evidence-"));
  const packet = renderCounselReviewPacket(built.corpus);
  const packetPath = path.join(temporaryDirectory, "counsel-review-packet.md");
  const receiptPath = path.join(temporaryDirectory, "counsel-review-packet.receipt.json");
  writeFileSync(packetPath, packet, "utf8");
  writeFileSync(
    receiptPath,
    renderCounselReviewPacketReceipt(buildCounselReviewPacketReceipt(built.corpus, Buffer.from(packet, "utf8"))),
    "utf8",
  );

  const bodies = {};
  for (const required of REQUIRED_PUBLIC_PRESENCE_PAGES) {
    bodies[required.path] = `<html><head><title>${required.name}</title></head><body>${LAUNCH_BODY}</body></html>`;
  }
  for (const policy of built.corpus.policies.filter((candidate) => candidate.launchRequired)) {
    bodies[policy.href] =
      `<html><head><title>${policy.policyKey}</title></head><body><main data-policy-key="${policy.policyKey}" data-policy-version="${policy.version}" data-policy-publication-status="published" data-policy-effective-at="2026-09-01T00:00:00.000Z">${LAUNCH_BODY}</main></body></html>`;
  }
  for (const article of built.corpus.complianceArticles) {
    bodies[article.href] = `<html><head><title>${article.slug}</title></head><body>${LAUNCH_BODY}</body></html>`;
  }

  successfulAudit = await auditPublicPresenceCopy(
    {
      baseUrl: "https://chasesets.com",
      mode: "launch",
      checkedAt: AUDIT_CHECKED_AT,
      counselPacketPath: packetPath,
      counselPacketReceiptPath: receiptPath,
    },
    {
      fetch: async (url) => {
        const requested = new URL(url).pathname;
        const body = bodies[requested];
        return body === undefined
          ? { status: 404, url, text: async () => "" }
          : { status: 200, url, text: async () => body };
      },
      membership: resolveLegalReviewMembership(authorities),
      corpus: built,
    },
  );
  if (!successfulAudit.passesPublicPresenceCopyAudit) {
    throw new Error(`expected a passing launch audit, got: ${(successfulAudit.errors ?? []).join(" | ")}`);
  }

  // A real prelaunch record, not a launch record with its mode relabelled: the
  // two modes have different exact row shapes, so only a genuine prelaunch run
  // proves that promotion refuses a non-launch audit for the right reason.
  successfulPrelaunchAudit = await auditPublicPresenceCopy(
    { baseUrl: "https://chasesets.com", mode: "prelaunch", checkedAt: AUDIT_CHECKED_AT },
    {
      fetch: async (url) => ({
        status: 200,
        url,
        text: async () =>
          `<html><head><title>${new URL(url).pathname}</title></head><body>${PRELAUNCH_BODY}</body></html>`,
      }),
      membership: resolveLegalReviewMembership(authorities),
    },
  );
  if (!successfulPrelaunchAudit.passesPublicPresenceCopyAudit) {
    throw new Error(`expected a passing prelaunch audit, got: ${(successfulPrelaunchAudit.errors ?? []).join(" | ")}`);
  }

  canonicalMembership = await resolveCanonicalLegalCorpusMembership();
  if (!canonicalMembership.ok) {
    throw new Error(`expected canonical membership, got: ${canonicalMembership.errors.join(" | ")}`);
  }
}, 120_000);

/** The terminal launch consumer's own revalidation of a promotion projection. */
function terminalProjectionErrors(evidence) {
  const rowErrors = [];
  validatePromotionLegalCorpusProjection(evidence, canonicalMembership, rowErrors);
  return rowErrors;
}

afterAll(() => {
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

function review(overrides = {}) {
  return {
    reviewReference: "LAUNCH-REVIEW-PROOF-2026-09-05",
    reviewCompletedAt: "2026-09-05T01:45:00.000Z",
    environment: "production",
    releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
    stagingWorkflowRunReference: "platform-deploy-staging-26688444710",
    productionWorkflowRunReference: "platform-deploy-production-26688444710",
    checkoutLaunchEvidenceReference: "CHECKOUT-LAUNCH-2026-09-05",
    checkoutLaunchEvidenceCompletedAt: "2026-09-05T01:20:00.000Z",
    publicPresenceReviewReference: "PUBLIC-PRESENCE-2026-09-05",
    publicPresenceCopyAuditReference: "PUBLIC-PRESENCE-COPY-AUDIT-2026-09-05",
    policyPagesReviewReference: "PUBLIC-POLICIES-2026-09-05",
    rollbackOwnerReference: "ROLLBACK-OWNER-2026-09-05",
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
    rollbackOwnerAssigned: true,
    ucpAp2Owner: "Checkout and Payments",
    publicLaunchClaimsEnabled: false,
    certificationApproved: false,
    certificationReference: "",
    ucpAp2ClaimsReviewReference: "UCP-AP2-CLAIMS-REVIEW-2026-09-05",
    uncertifiedClaimsAbsent: true,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    review: review(),
    audit: successfulAudit,
    reference: "LAUNCH-REVIEW-2026-09-05",
    owner: "Platform Operations",
    checkedAt: CHECKED_AT,
    ...overrides,
  };
}

function writeJson(name, value) {
  const filePath = path.join(temporaryDirectory, name);
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

describe("marketplace promotion evidence: authoritative launch consumption", () => {
  it("derives the complete legal-corpus projection from the audit record through the real file-reading CLI path", async () => {
    const evidence = await runPromotionEvidence({
      reviewPath: writeJson("review.json", review()),
      copyAuditPath: writeJson("audit.json", successfulAudit),
      reference: "LAUNCH-REVIEW-2026-09-05",
      owner: "Platform Operations",
      checkedAt: CHECKED_AT,
    });

    expect(evidence).toEqual({
      schemaVersion: MARKETPLACE_PROMOTION_EVIDENCE_VERSION,
      passesPromotionGate: true,
      marketplacePromotion: {
        approved: true,
        reference: "LAUNCH-REVIEW-2026-09-05",
        owner: "Platform Operations",
        checkedAt: CHECKED_AT,
        reviewReference: "LAUNCH-REVIEW-PROOF-2026-09-05",
        reviewCompletedAt: "2026-09-05T01:45:00.000Z",
        environment: "production",
        releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
        stagingWorkflowRunReference: "platform-deploy-staging-26688444710",
        productionWorkflowRunReference: "platform-deploy-production-26688444710",
        checkoutLaunchEvidenceReference: "CHECKOUT-LAUNCH-2026-09-05",
        publicPresenceReviewReference: "PUBLIC-PRESENCE-2026-09-05",
        publicPresenceCopyAuditReference: "PUBLIC-PRESENCE-COPY-AUDIT-2026-09-05",
        policyPagesReviewReference: "PUBLIC-POLICIES-2026-09-05",
        rollbackOwnerReference: "ROLLBACK-OWNER-2026-09-05",
        checkoutLaunchEvidenceCompletedAt: "2026-09-05T01:20:00.000Z",
        publicPresenceCopyAuditVersion: MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
        publicPresenceCopyAuditBaseUrl: "https://chasesets.com",
        publicPresenceCopyAuditCompletedAt: AUDIT_CHECKED_AT,
        publicPresenceCopyAuditMode: "launch",
        publicPresenceCopyAuditRequiredPageCount: 8,
        publicPresenceCopyAuditRequiredPagePaths: [...REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS],
        publicPresenceCopyAuditLaunchRequiredPolicyCount: 6,
        publicPresenceCopyAuditLaunchRequiredPolicyKeys: [
          "terms-of-service",
          "privacy-policy",
          "seller-agreement",
          "payments-terms",
          "agent-connector-terms",
          "founders-offer-terms",
        ],
        publicPresenceCopyAuditComplianceArticleCount: 5,
        publicPresenceCopyAuditComplianceArticleSlugs: [
          "community-guidelines-and-enforcement",
          "intellectual-property-and-dmca",
          "prohibited-and-restricted-items",
          "sales-tax",
          "tax-reporting-1099k",
        ],
        publicPresenceCopyAuditUniqueFetchedPathCount: 17,
        publicPresenceCopyAuditLegalCorpusDigest: successfulAudit.legalCorpusDigest,
        counselPacketSchemaVersion: "counsel-review-packet/v1",
        counselPacketSha256: successfulAudit.counselPacket.sha256,
        counselPacketUtf8Bytes: successfulAudit.counselPacket.utf8Bytes,
        counselPacketCorpusSha256: successfulAudit.counselPacket.corpusSha256,
        counselPacketVerified: true,
        publicPresenceCopyAuditPassed: true,
        publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved: true,
        publicPresenceCopyAuditPolicyPagesReviewed: true,
        publicPresenceCopyAuditComplianceArticlesReviewed: true,
        publicPresenceCopyAuditDmcaRegistrationMarkerAbsent: true,
        publicPresenceCopyAuditUncertifiedClaimsAbsent: true,
        publicPresenceCopyAuditPageEvidence: {
          fetchedPathCount: 17,
          requiredPagePaths: [...REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS],
          launchPolicyPolicyKeys: [
            "terms-of-service",
            "privacy-policy",
            "seller-agreement",
            "payments-terms",
            "agent-connector-terms",
            "founders-offer-terms",
          ],
          complianceArticleSlugs: [
            "community-guidelines-and-enforcement",
            "intellectual-property-and-dmca",
            "prohibited-and-restricted-items",
            "sales-tax",
            "tax-reporting-1099k",
          ],
          verifiedOnAuditedOriginCount: 17,
        },
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
        rollbackOwnerAssigned: true,
        publicPresenceLaunchCopyReviewed: true,
        futureOnlyLaunchCopyRemoved: true,
        policyPagesReviewed: true,
      },
      ucpAp2Marketing: {
        owner: "Checkout and Payments",
        publicLaunchClaimsEnabled: false,
        certificationApproved: false,
        certificationReference: "",
        claimsReviewReference: "UCP-AP2-CLAIMS-REVIEW-2026-09-05",
        uncertifiedClaimsAbsent: true,
      },
    });
  });

  it("keeps only non-audit operator proofs in the required proof list", () => {
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
      "rollbackOwnerAssigned",
    ]);
    for (const retired of ["publicPresenceLaunchCopyReviewed", "futureOnlyLaunchCopyRemoved", "policyPagesReviewed"]) {
      expect(REQUIRED_MARKETPLACE_PROMOTION_PROOFS).not.toContain(retired);
    }
  });
});

describe("marketplace promotion evidence: caller-grafted authority is rejected", () => {
  it("rejects every retired copy-audit, counsel-packet, and legacy proof field as an unknown review key", () => {
    const grafted = buildPromotionEvidence(
      input({
        review: review({
          publicPresenceCopyAuditVersion: MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
          publicPresenceCopyAuditPassed: true,
          publicPresenceCopyAuditLegalCorpusDigest: successfulAudit.legalCorpusDigest,
          counselPacketVerified: true,
          publicPresenceLaunchCopyReviewed: true,
          futureOnlyLaunchCopyRemoved: true,
          policyPagesReviewed: true,
        }),
      }),
    );

    expect(grafted.passesPromotionGate).toBe(false);
    for (const field of [
      "publicPresenceCopyAuditVersion",
      "publicPresenceCopyAuditPassed",
      "publicPresenceCopyAuditLegalCorpusDigest",
      "counselPacketVerified",
      "publicPresenceLaunchCopyReviewed",
      "futureOnlyLaunchCopyRemoved",
      "policyPagesReviewed",
    ]) {
      expect(grafted.errors.join(" ")).toContain(`unexpected field '${field}'`);
    }
  });

  it("cannot change the derived result by mutating review assertions while the audit is held fixed", () => {
    const candidate = buildPromotionEvidence(input());
    expect(candidate.passesPromotionGate).toBe(true);

    for (const overrides of [
      { finalLaunchReviewApproved: false },
      { rollbackOwnerAssigned: false },
      { publicPresenceCopyAuditReference: "todo" },
      { environment: "staging" },
      { releaseCommit: "release-candidate" },
    ]) {
      const mutated = buildPromotionEvidence(input({ review: review(overrides) }));
      expect(mutated.passesPromotionGate, JSON.stringify(overrides)).toBe(false);
      // The derived legal-corpus projection is unchanged: it comes from the
      // audit record, which the review cannot touch.
      expect(mutated.marketplacePromotion.publicPresenceCopyAuditLegalCorpusDigest).toBe(
        candidate.marketplacePromotion.publicPresenceCopyAuditLegalCorpusDigest,
      );
      expect(mutated.marketplacePromotion.counselPacketSha256).toBe(candidate.marketplacePromotion.counselPacketSha256);
      expect(mutated.marketplacePromotion.publicPresenceCopyAuditLaunchRequiredPolicyKeys).toEqual(
        candidate.marketplacePromotion.publicPresenceCopyAuditLaunchRequiredPolicyKeys,
      );
    }
  });

  it("rejects a v1 review record as historical authority without crashing", () => {
    const v1Review = {
      ...review(),
      publicPresenceCopyAuditVersion: "marketplace-public-presence-copy-audit/v1",
      publicPresenceCopyAuditBaseUrl: "https://chasesets.com",
      publicPresenceCopyAuditCompletedAt: AUDIT_CHECKED_AT,
      publicPresenceCopyAuditMode: "launch",
      publicPresenceCopyAuditRequiredPageCount: 8,
      publicPresenceCopyAuditPassed: true,
      publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved: true,
      publicPresenceCopyAuditPolicyPagesReviewed: true,
      publicPresenceCopyAuditUncertifiedClaimsAbsent: true,
      publicPresenceLaunchCopyReviewed: true,
      futureOnlyLaunchCopyRemoved: true,
      policyPagesReviewed: true,
    };

    const evidence = buildPromotionEvidence(input({ review: v1Review }));
    expect(evidence.schemaVersion).toBe(MARKETPLACE_PROMOTION_EVIDENCE_VERSION);
    expect(evidence.passesPromotionGate).toBe(false);
    expect(evidence.errors.join(" ")).toContain("marketplace-promotion-evidence/v2 derives every copy-audit");
  });
});

describe("marketplace promotion evidence: audit input authority", () => {
  it("requires the audit record and refuses a missing, v1, prelaunch, or failing audit", () => {
    expect(validatePromotionEvidenceOptions({ reviewPath: "review.json", copyAuditPath: null })).toEqual([
      "MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_RECORD or --public-presence-copy-audit is required.",
    ]);

    const omitted = buildPromotionEvidence(input({ audit: undefined }));
    expect(omitted.passesPromotionGate).toBe(false);
    expect(omitted.errors.join(" ")).toContain(
      `requires an exact successful launch-mode ${MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION} record`,
    );
    expect(omitted.marketplacePromotion.publicPresenceCopyAuditLegalCorpusDigest).toBeNull();
    expect(omitted.marketplacePromotion.counselPacketVerified).toBeNull();

    const v1Audit = buildPromotionEvidence(
      input({ audit: { ...successfulAudit, schemaVersion: "marketplace-public-presence-copy-audit/v1" } }),
    );
    expect(v1Audit.passesPromotionGate).toBe(false);
    expect(v1Audit.errors.join(" ")).toContain(
      `schemaVersion must be ${MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION}`,
    );

    const prelaunchAudit = buildPromotionEvidence(input({ audit: successfulPrelaunchAudit }));
    expect(prelaunchAudit.passesPromotionGate).toBe(false);
    expect(prelaunchAudit.errors).toContain(
      "Marketplace promotion review must use a launch-mode Public Presence copy audit.",
    );

    const failingAudit = buildPromotionEvidence(
      input({ audit: { ...successfulAudit, passesPublicPresenceCopyAudit: false, errors: ["synthetic failure"] } }),
    );
    expect(failingAudit.passesPromotionGate).toBe(false);
    expect(failingAudit.errors).toContain(
      "Marketplace promotion requires a passing Public Presence copy audit record.",
    );
  });

  it("refuses an unverified packet, a stale digest, a count-only membership, and reordered members", () => {
    // The producer never reports a pass on an unverified packet, so the mutant
    // is the exact record it would emit for that one failure.
    const unverified = buildPromotionEvidence(
      input({
        audit: {
          ...successfulAudit,
          counselPacket: { ...successfulAudit.counselPacket, verified: false },
          passesPublicPresenceCopyAudit: false,
          errors: ["Retained counsel review packet bytes do not hash to the digest its receipt records."],
        },
      }),
    );
    expect(unverified.passesPromotionGate).toBe(false);
    expect(unverified.errors).toContain(
      "Marketplace promotion requires a copy audit that verified the retained counsel review packet bytes.",
    );

    const staleDigest = buildPromotionEvidence(
      input({
        audit: {
          ...successfulAudit,
          counselPacket: { ...successfulAudit.counselPacket, corpusSha256: `sha256:${"0".repeat(64)}` },
        },
      }),
    );
    expect(staleDigest.passesPromotionGate).toBe(false);
    expect(staleDigest.errors).toContain(
      "Marketplace promotion requires the retained counsel packet corpus digest to equal the audited current corpus digest.",
    );

    const countOnly = buildPromotionEvidence(input({ audit: { ...successfulAudit, complianceArticleSlugs: null } }));
    expect(countOnly.passesPromotionGate).toBe(false);
    expect(countOnly.errors.join(" ")).toContain("must both be null or both be exact");

    const reordered = buildPromotionEvidence(
      input({
        audit: {
          ...successfulAudit,
          requiredPagePaths: [...REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS].reverse(),
        },
      }),
    );
    expect(reordered.passesPromotionGate).toBe(false);
    expect(reordered.errors.join(" ")).toContain(
      "requiredPagePaths must be the canonical required-page paths in order",
    );
  });

  it("refuses an audit whose rows are not the fetch plan its own membership implies", () => {
    // One decisive mutation: counts, membership pairs, digests, packet
    // verification, and every success boolean are retained from the real
    // record; only the 17 row identities are replaced.
    const crafted = {
      ...successfulAudit,
      pages: successfulAudit.pages.map((row, index) => ({
        ...row,
        name: `synthetic-${index}`,
        path: `/synthetic-${index}`,
        url: `https://chasesets.com/synthetic-${index}`,
      })),
    };
    expect(crafted.uniqueFetchedPathCount).toBe(17);
    expect(crafted.passesPublicPresenceCopyAudit).toBe(true);

    const evidence = buildPromotionEvidence(input({ audit: crafted }));
    expect(evidence.passesPromotionGate).toBe(false);
    expect(evidence.errors.join(" ")).toContain("must open with the canonical required public pages in order");
    // No page evidence survives into the projection the terminal gate reads.
    expect(evidence.marketplacePromotion.publicPresenceCopyAuditPageEvidence).toBeNull();
    expect(evidence.marketplacePromotion.publicPresenceCopyAuditPassed).toBeNull();
    // All three layers refuse it: record validation, promotion, and the
    // terminal launch-gate projection.
    expect(terminalProjectionErrors(evidence).join(" ")).toContain(
      "publicPresenceCopyAuditPageEvidence must carry the audited page rows",
    );
    // The unmutated control still clears every layer end to end.
    expect(terminalProjectionErrors(buildPromotionEvidence(input()))).toEqual([]);

    // A record that keeps canonical row identities but never proved them on
    // the audited origin cannot claim the success booleans either.
    const offOrigin = {
      ...successfulAudit,
      pages: successfulAudit.pages.map((row) => ({ ...row, url: `https://synthetic.invalid${row.path}` })),
    };
    const offOriginEvidence = buildPromotionEvidence(input({ audit: offOrigin }));
    expect(offOriginEvidence.passesPromotionGate).toBe(false);
    expect(offOriginEvidence.errors.join(" ")).toContain("uncertifiedClaimsAbsent must agree with its own page rows");
    expect(offOriginEvidence.marketplacePromotion.publicPresenceCopyAuditPageEvidence).toBeNull();
  });

  it("uses the audit record's own checkedAt as the copy-audit completion instant and enforces its freshness", () => {
    const fresh = buildPromotionEvidence(input());
    expect(fresh.marketplacePromotion.publicPresenceCopyAuditCompletedAt).toBe(AUDIT_CHECKED_AT);

    const stale = buildPromotionEvidence(
      input({ audit: { ...successfulAudit, checkedAt: "2026-07-01T01:30:00.000Z" } }),
    );
    expect(stale.passesPromotionGate).toBe(false);
    expect(stale.errors).toContain(
      "Marketplace promotion publicPresenceCopyAuditCompletedAt cannot be older than 30 days.",
    );
  });

  it("keeps the retained UCP/AP2 certification contract", () => {
    const missingCertification = buildPromotionEvidence(
      input({
        review: review({ publicLaunchClaimsEnabled: true, certificationApproved: false, certificationReference: "" }),
      }),
    );
    expect(missingCertification.passesPromotionGate).toBe(false);
    expect(missingCertification.errors).toContain("UCP/AP2 public launch claims require certificationApproved=true.");
    expect(missingCertification.errors).toContain("UCP/AP2 public launch claims require a certificationReference.");

    const certified = buildPromotionEvidence(
      input({
        review: review({
          publicLaunchClaimsEnabled: true,
          certificationApproved: true,
          certificationReference: "UCP-AP2-CERTIFICATION-2026-09-05",
        }),
      }),
    );
    expect(certified.passesPromotionGate).toBe(true);
  });

  it("parses the audit-record option from flags and environment", () => {
    expect(
      parsePromotionEvidenceArgs(
        [
          "--review",
          "secure/promotion.json",
          "--public-presence-copy-audit",
          "secure/copy-audit.json",
          "--reference",
          "LAUNCH-REVIEW-2026-09-05",
          "--owner",
          "Launch Ops",
          "--checked-at",
          CHECKED_AT,
        ],
        {},
      ),
    ).toEqual({
      reviewPath: "secure/promotion.json",
      copyAuditPath: "secure/copy-audit.json",
      reference: "LAUNCH-REVIEW-2026-09-05",
      owner: "Launch Ops",
      checkedAt: CHECKED_AT,
    });

    expect(
      parsePromotionEvidenceArgs([], {
        MARKETPLACE_PROMOTION_REVIEW_RECORD: "secure/promotion.json",
        MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_RECORD: "secure/copy-audit.json",
        PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE: "LAUNCH-REVIEW-2026-09-05",
      }),
    ).toMatchObject({
      reviewPath: "secure/promotion.json",
      copyAuditPath: "secure/copy-audit.json",
      owner: "Platform Operations",
    });
  });
});
