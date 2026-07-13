import { describe, expect, it } from "vitest";
import type { ListingEvidencePolicyEvaluation } from "../../listing-evidence-policy/domain/policy";
import {
  createListingEvidenceRequirementSnapshot,
  listingEvidenceRequirementHash,
} from "./evidence-requirement-snapshot";

const evaluation: ListingEvidencePolicyEvaluation = {
  policyId: "pol_evidence",
  policyVersion: 4,
  policyHash: "sha256:policy",
  matchedRuleIds: ["rule_front"],
  requirements: {
    minimumPhotoCount: 1,
    requiredSlots: [
      {
        slotId: "front",
        viewKind: "front",
        minimumWidthPixels: 1000,
        minimumHeightPixels: null,
        maximumAgeHours: null,
      },
    ],
    sellerTrustRequirements: [],
    buyerAcknowledgment: "none",
  },
  effectiveInterval: { from: "2026-07-01T00:00:00.000Z", until: null },
  explanationCodes: ["rule-matched:rule_front"],
};

describe("Listing Evidence requirement snapshot", () => {
  it("records the exact policy evaluation and a stable content hash", () => {
    const snapshot = createListingEvidenceRequirementSnapshot(evaluation, "2026-07-13T12:00:00.000Z");

    expect(snapshot).toEqual({
      policyId: "pol_evidence",
      policyVersion: 4,
      policyHash: "sha256:policy",
      evaluatedAt: "2026-07-13T12:00:00.000Z",
      requirementHash: listingEvidenceRequirementHash(evaluation),
      matchedRuleIds: ["rule_front"],
      explanationCodes: ["rule-matched:rule_front"],
      requirements: evaluation.requirements,
    });
    expect(snapshot.requirementHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("changes the hash when the resolved requirements change", () => {
    const revised = {
      ...evaluation,
      requirements: { ...evaluation.requirements, minimumPhotoCount: 2 },
    };

    expect(listingEvidenceRequirementHash(revised)).not.toBe(listingEvidenceRequirementHash(evaluation));
  });
});
