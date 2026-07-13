import { describe, expect, it } from "vitest";
import type { MarketplaceListingPhoto } from "./domain";
import type { ListingEvidenceRequirementSnapshot } from "./evidence-requirement-snapshot";
import { evaluateListingEvidenceReadiness } from "./listing-evidence-readiness";

function snapshot(overrides: Partial<ListingEvidenceRequirementSnapshot> = {}): ListingEvidenceRequirementSnapshot {
  return {
    policyId: "pol_evidence",
    policyVersion: 1,
    policyHash: "sha256:policy",
    evaluatedAt: "2026-07-13T12:00:00.000Z",
    requirementHash: "sha256:requirements",
    matchedRuleIds: [],
    explanationCodes: [],
    requirements: {
      minimumPhotoCount: 1,
      requiredSlots: [],
      sellerTrustRequirements: [],
      buyerAcknowledgment: "none",
    },
    ...overrides,
  };
}

function evidence(): MarketplaceListingPhoto {
  return {
    photoId: "lpho_front",
    originalFilename: "front.webp",
    altText: null,
    slotId: null,
    viewKind: null,
    status: "active",
    sortOrder: 0,
    capturedAt: null,
    uploadedAt: "2026-07-13T12:00:00.000Z",
    assetRevision: "revision_front",
    replacesPhotoId: null,
    assetSet: {
      kind: "listing-photo",
      sourceHash: "hash_front",
      source: {
        role: "source",
        width: 1200,
        height: 1600,
        density: null,
        mediaType: "image/webp",
        storageKey: "listings/front/source.webp",
        publicUrl: "https://assets.test/front/source.webp",
        byteSize: 1000,
        generatedAt: "2026-07-13T12:00:00.000Z",
      },
      variants: [],
    },
  };
}

describe("evaluateListingEvidenceReadiness", () => {
  it("fails closed when no resolved requirement snapshot is available", () => {
    expect(
      evaluateListingEvidenceReadiness({
        snapshot: null,
        evidence: [],
        seller: { reviewCount: 0, badgeKeys: [] },
      }),
    ).toEqual({
      ready: false,
      requirementHash: null,
      unmetCodes: ["listing-evidence-requirements-unavailable"],
      coverage: null,
    });
  });

  it("uses evidence coverage and preserves the requirement hash", () => {
    const result = evaluateListingEvidenceReadiness({
      snapshot: snapshot(),
      evidence: [evidence()],
      seller: { reviewCount: 0, badgeKeys: [] },
    });

    expect(result.ready).toBe(true);
    expect(result.requirementHash).toBe("sha256:requirements");
    expect(result.coverage?.complete).toBe(true);
  });

  it("enforces generic seller-trust clauses independently of photo coverage", () => {
    const result = evaluateListingEvidenceReadiness({
      snapshot: snapshot({
        requirements: {
          minimumPhotoCount: 0,
          requiredSlots: [],
          sellerTrustRequirements: [
            {
              ruleId: "trusted-seller",
              satisfaction: "any",
              minimumReviewCount: 10,
              acceptedBadgeKeys: ["verified-seller"],
            },
          ],
          buyerAcknowledgment: "none",
        },
      }),
      evidence: [],
      seller: { reviewCount: 9, badgeKeys: [] },
    });

    expect(result.coverage?.complete).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.unmetCodes).toEqual(["seller-trust-requirement-unmet"]);
  });
});
