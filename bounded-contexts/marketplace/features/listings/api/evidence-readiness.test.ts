import { describe, expect, it } from "vitest";
import type { ListingEvidencePolicyEvaluation } from "../../listing-evidence-policy/domain/policy";
import { createListingEvidenceRequirementSnapshot } from "../domain/evidence-requirement-snapshot";
import { evaluateListingEvidenceReadiness } from "../domain/listing-evidence-readiness";
import { buildMarketplaceListingEvidenceReadiness } from "./evidence-readiness";

const evaluation: ListingEvidencePolicyEvaluation = {
  policyId: "pol_1",
  policyVersion: 3,
  policyHash: "sha256:test",
  matchedRuleIds: ["graded-item-views"],
  requirements: {
    minimumPhotoCount: 2,
    requiredSlots: [
      {
        slotId: "front",
        viewKind: "front",
        minimumWidthPixels: null,
        minimumHeightPixels: null,
        maximumAgeHours: null,
      },
      {
        slotId: "back",
        viewKind: "back",
        minimumWidthPixels: null,
        minimumHeightPixels: null,
        maximumAgeHours: null,
      },
    ],
    sellerTrustRequirements: [],
    buyerAcknowledgment: "none",
  },
  effectiveInterval: { from: "2026-07-13T00:00:00.000Z", until: null },
  explanationCodes: ["listing-evidence.graded-item"],
};

describe("Marketplace Listing Evidence readiness", () => {
  it("maps every canonical unmet code to a concrete localized next action and affected slots", () => {
    const snapshot = createListingEvidenceRequirementSnapshot(evaluation, "2026-07-13T12:00:00.000Z");
    const result = evaluateListingEvidenceReadiness({
      snapshot,
      evidence: [],
      seller: { reviewCount: 0, badgeKeys: [] },
      now: "2026-07-13T12:00:00.000Z",
    });
    const readiness = buildMarketplaceListingEvidenceReadiness(snapshot, [], result);

    expect(readiness.ready).toBe(false);
    expect(readiness.coverage).toMatchObject({
      complete: false,
      unmetCodes: ["min-photo-count-unmet", "slot-missing"],
      activePhotoCount: 0,
      minimumPhotoCount: 2,
    });
    expect(readiness.nextActions).toEqual([
      {
        code: "min-photo-count-unmet",
        localeKey: "marketplace.features.listings.evidenceCoverage.min-photo-count-unmet",
        slotIds: [],
      },
      {
        code: "slot-missing",
        localeKey: "marketplace.features.listings.evidenceCoverage.slot-missing",
        slotIds: ["back", "front"],
      },
    ]);
    expect(readiness.publicGallery).toEqual([]);
  });
});
