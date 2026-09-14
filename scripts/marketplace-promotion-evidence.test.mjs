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
  validatePublicPresenceCopyAuditRecord,
  projectPublicPresenceCopyAuditPageEvidence,
} from "./marketplace-public-presence-copy-audit.mjs";
import {
  MARKETPLACE_PROMOTION_EVIDENCE_VERSION,
  REQUIRED_MARKETPLACE_PROMOTION_PROOFS,
  buildPromotionEvidence as buildEvidence,
  parsePromotionEvidenceArgs,
  runPromotionEvidence as runEvidence,
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
let producerInput;
let producerDependencies;
let producerBodies;
let producerAuthorities;
const buildPromotionEvidence = (input) => buildEvidence(input, { auditAuthority: canonicalMembership });
const runPromotionEvidence = (options) => runEvidence(options, { auditAuthority: canonicalMembership });

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
  producerAuthorities = authorities;
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

  producerBodies = bodies;
  producerInput = {
    baseUrl: "https://chasesets.com",
    mode: "launch",
    checkedAt: AUDIT_CHECKED_AT,
    counselPacketPath: packetPath,
    counselPacketReceiptPath: receiptPath,
  };
  producerDependencies = {
    fetch: async (url) => {
      const requested = new URL(url).pathname;
      const body = bodies[requested];
      return body === undefined
        ? { status: 404, url, text: async () => "" }
        : { status: 200, url, text: async () => body };
    },
    membership: resolveLegalReviewMembership(authorities),
    corpus: built,
  };
  successfulAudit = await auditPublicPresenceCopy(producerInput, producerDependencies);
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

  canonicalMembership = await resolveCanonicalLegalCorpusMembership(producerDependencies);
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
    releaseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    stagingWorkflowRunReference: "SYNTHETIC-STAGING-WORKFLOW-0001",
    productionWorkflowRunReference: "SYNTHETIC-PRODUCTION-WORKFLOW-0001",
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

describe("G4 bounded three-consumer discriminators", () => {
  function assertThreeConsumers(audit, accepted, authority = canonicalMembership) {
    const validation = validatePublicPresenceCopyAuditRecord(audit, authority);
    expect(validation.ok, JSON.stringify(validation.errors)).toBe(accepted);
    const promotion = buildEvidence(input({ audit }), { auditAuthority: authority });
    expect(promotion.passesPromotionGate, JSON.stringify(promotion.errors)).toBe(accepted);
    // Do not feed the rejected producer's null projection to the terminal
    // check: retain the successful envelope and independently replace rows.
    const terminal = buildPromotionEvidence(input());
    terminal.marketplacePromotion.publicPresenceCopyAuditPageEvidence =
      projectPublicPresenceCopyAuditPageEvidence(audit);
    const errors = [];
    validatePromotionLegalCorpusProjection(terminal, authority, errors);
    expect(errors.length === 0, JSON.stringify(errors)).toBe(accepted);
  }

  it("F1-canonical-route-version-three-consumers", () => {
    assertThreeConsumers(successfulAudit, true);
    for (const mutation of ["paths", "versions", "paths-and-versions"]) {
      const mutant = structuredClone(successfulAudit);
      for (const row of mutant.pages) {
        if (mutation !== "versions" && !row.categories.includes("required-page")) {
          row.path = `/synthetic-substitution-${row.name}`;
          row.url = new URL(row.path, mutant.baseUrl).href;
        }
        if (mutation !== "paths" && row.policyPublicationMetadata) row.policyPublicationMetadata.version = "v999";
      }
      expect(mutant.pages).toHaveLength(17);
      expect(mutant.launchRequiredPolicyKeys).toEqual(successfulAudit.launchRequiredPolicyKeys);
      expect(mutant.complianceArticleSlugs).toEqual(successfulAudit.complianceArticleSlugs);
      assertThreeConsumers(mutant, false);
    }
  });

  it("F2-retained-marker-three-consumers", async () => {
    const markerAudit = await auditPublicPresenceCopy(producerInput, {
      ...producerDependencies,
      fetch: async (url) => ({
        status: 200,
        url,
        text: async () =>
          producerBodies[new URL(url).pathname] +
          (new URL(url).pathname === canonicalMembership.dmca.path ? canonicalMembership.dmca.marker : ""),
      }),
    });
    expect(markerAudit.pages).toHaveLength(17);
    expect(markerAudit.dmcaRegistrationMarkerAbsent).toBe(false);
    const markerRow = markerAudit.pages.find((row) => row.path === canonicalMembership.dmca.path);
    const cleanRow = successfulAudit.pages.find((row) => row.path === canonicalMembership.dmca.path);
    expect(markerRow).toEqual({
      ...cleanRow,
      dmcaMarkerScan: { ...cleanRow.dmcaMarkerScan, responseMarkerPresent: true },
    });
    const laundered = { ...markerAudit, dmcaRegistrationMarkerAbsent: true, passesPublicPresenceCopyAudit: true };
    delete laundered.errors;
    assertThreeConsumers(laundered, false);
    assertThreeConsumers(successfulAudit, true);
  });

  it("rejects each malformed retained scan, member binding and nested row independently", () => {
    const mutations = [
      (row) => {
        delete row.dmcaMarkerScan;
      },
      (row) => {
        row.dmcaMarkerScan.extra = true;
      },
      (row) => {
        row.dmcaMarkerScan.schemaVersion = "dmca-marker-scan/v999";
      },
      (row) => {
        row.dmcaMarkerScan.marker = "synthetic-other-marker";
      },
      (row) => {
        row.dmcaMarkerScan.sourceMarkerPresent = true;
      },
      (row) => {
        row.dmcaMarkerScan.sourceMarkerPresent = {};
      },
      (row) => {
        row.dmcaMarkerScan.responseMarkerPresent = null;
      },
      (row) => {
        row.dmcaMarkerScan.responseMarkerPresent = [];
      },
      (row) => {
        row.status = 404;
      },
      (row) => {
        row.status = 999;
      },
      (row) => {
        row.name = "synthetic-other-member";
      },
      (row) => {
        row.path = "/synthetic-other-dmca";
        row.url = new URL(row.path, successfulAudit.baseUrl).href;
      },
      (row) => {
        row.url = `https://synthetic.invalid${row.path}`;
      },
      (row) => {
        row.title = "x".repeat(4097);
      },
    ];
    for (const mutate of mutations) {
      const audit = structuredClone(successfulAudit);
      mutate(audit.pages.find((row) => row.path === canonicalMembership.dmca.path));
      assertThreeConsumers(audit, false);
    }
    const misplaced = structuredClone(successfulAudit);
    misplaced.pages[0].dmcaMarkerScan = structuredClone(
      misplaced.pages.find((row) => row.dmcaMarkerScan).dmcaMarkerScan,
    );
    assertThreeConsumers(misplaced, false);
    const nested = structuredClone(successfulAudit);
    nested.pages.find((row) => row.policyPublicationMetadata).policyPublicationMetadata.extra = {};
    assertThreeConsumers(nested, false);
    const dateOnly = structuredClone(successfulAudit);
    dateOnly.pages.find((row) => row.policyPublicationMetadata).policyPublicationMetadata.effectiveAt = "2026-09-01";
    assertThreeConsumers(dateOnly, false);
    assertThreeConsumers(successfulAudit, false, { ok: false, errors: ["SYNTHETIC unavailable source"] });
    assertThreeConsumers(successfulAudit, false, {
      ...canonicalMembership,
      dmca: { ...canonicalMembership.dmca, sourceMarkerPresent: true },
    });
    assertThreeConsumers(successfulAudit, true);
  });

  it("retains a source-only marker from the exact current normalized corpus", async () => {
    const source = {
      ...producerAuthorities,
      helpArticleSources: producerAuthorities.helpArticleSources.map((article) =>
        article.fileName === "intellectual-property-and-dmca.en.md"
          ? { ...article, source: `${article.source}\n${canonicalMembership.dmca.marker}\n` }
          : article,
      ),
    };
    const corpus = buildLegalReviewCorpus(source);
    expect(corpus.ok, JSON.stringify(corpus.errors)).toBe(true);
    const packet = Buffer.from(renderCounselReviewPacket(corpus.corpus));
    const receipt = buildCounselReviewPacketReceipt(corpus.corpus, packet);
    const dependencies = {
      ...producerDependencies,
      corpus,
      readTextFile: async () => ({ ok: true, content: JSON.stringify(receipt) }),
      readBinaryFile: async () => ({ ok: true, content: packet }),
    };
    const authority = await resolveCanonicalLegalCorpusMembership(dependencies);
    const audit = await auditPublicPresenceCopy(producerInput, dependencies);
    const row = audit.pages.find((page) => page.path === authority.dmca.path);
    expect(audit.pages).toHaveLength(17);
    expect(row.dmcaMarkerScan.sourceMarkerPresent).toBe(true);
    expect(row.dmcaMarkerScan.responseMarkerPresent).toBe(false);
    expect(audit.dmcaRegistrationMarkerAbsent).toBe(false);
    expect(validatePublicPresenceCopyAuditRecord(audit, authority).ok).toBe(true);
    const laundered = { ...audit, dmcaRegistrationMarkerAbsent: true, passesPublicPresenceCopyAudit: true };
    delete laundered.errors;
    expect(validatePublicPresenceCopyAuditRecord(laundered, authority).ok).toBe(false);
    expect(buildEvidence(input({ audit: laundered }), { auditAuthority: authority }).passesPromotionGate).toBe(false);
    const terminal = buildPromotionEvidence(input());
    Object.assign(terminal.marketplacePromotion, {
      publicPresenceCopyAuditLegalCorpusDigest: authority.legalCorpusDigest,
      counselPacketCorpusSha256: authority.legalCorpusDigest,
      counselPacketSha256: audit.counselPacket.sha256,
      counselPacketUtf8Bytes: audit.counselPacket.utf8Bytes,
      publicPresenceCopyAuditPageEvidence: projectPublicPresenceCopyAuditPageEvidence(laundered),
    });
    const errors = [];
    validatePromotionLegalCorpusProjection(terminal, authority, errors);
    expect(errors.join(" ")).toContain("exact DMCA source and retained response scan");
  });

  it("retains the source scan and all 17 rows on null, non-200 and off-origin DMCA responses", async () => {
    for (const failure of ["fetch", "read", "non-200", "off-origin"]) {
      const audit = await auditPublicPresenceCopy(producerInput, {
        ...producerDependencies,
        fetch: async (url) => {
          if (new URL(url).pathname !== canonicalMembership.dmca.path) return producerDependencies.fetch(url);
          if (failure === "fetch") throw new Error("SYNTHETIC-PRIVATE-TRANSPORT");
          return {
            status: failure === "non-200" ? 404 : 200,
            url: failure === "off-origin" ? `https://synthetic.invalid${canonicalMembership.dmca.path}` : url,
            text: async () => {
              if (failure === "read") throw new Error("SYNTHETIC-PRIVATE-READ");
              return canonicalMembership.dmca.marker;
            },
          };
        },
      });
      expect(audit.pages).toHaveLength(17);
      expect(audit.counselPacket.verified).toBe(true);
      const row = audit.pages.find((page) => page.path === canonicalMembership.dmca.path);
      expect(row.dmcaMarkerScan).toEqual({
        schemaVersion: "dmca-marker-scan/v1",
        marker: canonicalMembership.dmca.marker,
        sourceMarkerPresent: false,
        responseMarkerPresent: ["fetch", "read"].includes(failure) ? null : true,
      });
      expect(validatePublicPresenceCopyAuditRecord(audit, canonicalMembership).ok).toBe(true);
      expect(JSON.stringify(audit)).not.toContain("SYNTHETIC-PRIVATE");
      const laundered = {
        ...audit,
        publicPresenceLaunchCopyReviewed: true,
        futureOnlyLaunchCopyRemoved: true,
        complianceArticlesReviewed: true,
        dmcaRegistrationMarkerAbsent: true,
        uncertifiedClaimsAbsent: true,
        passesPublicPresenceCopyAudit: true,
      };
      delete laundered.errors;
      assertThreeConsumers(laundered, false);
    }
  });
});

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
        releaseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        stagingWorkflowRunReference: "SYNTHETIC-STAGING-WORKFLOW-0001",
        productionWorkflowRunReference: "SYNTHETIC-PRODUCTION-WORKFLOW-0001",
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
          schemaVersion: "public-presence-audit-page-evidence/v1",
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
          pages: successfulAudit.pages,
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
    expect(evidence.errors.join(" ")).toContain("marketplace-promotion-evidence/v3 derives every copy-audit");
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
    // An unverified packet cannot retain fetched rows, even with pass=false.
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
      "Marketplace promotion copy audit input: Public Presence copy audit record fetched rows require the verified packet and current source corpus identity.",
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
      "Marketplace promotion copy audit input: Public Presence copy audit record fetched rows require the verified packet and current source corpus identity.",
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
