import { describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import {
  decodeListingEvidencePolicyValue,
  evaluateListingEvidencePolicy,
  LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
  listingEvidencePolicyHash,
  validateListingEvidencePolicy,
} from "./policy";

const baseFacts = {
  catalogItemId: "cat_1",
  productId: "prd_1",
  blueprintId: "bpr_1",
  categoryIds: ["ctg_1"],
  selectedOptions: [] as readonly { dimensionId: string; optionId: string }[],
  gradedItem: false,
  priceAmount: "10.00",
  seller: { reviewCount: 0, badgeKeys: [] as readonly string[], riskLevel: null },
};

describe("Marketplace Listing Evidence Policy", () => {
  it("selects Mint and Pristine by stable Option identity, never a label", () => {
    for (const optionId of [
      catalogSeedIds.dimensions.condition.optionIds.mint,
      catalogSeedIds.dimensions.condition.optionIds.pristine,
    ]) {
      const result = evaluateListingEvidencePolicy(
        LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
        {
          ...baseFacts,
          selectedOptions: [{ dimensionId: catalogSeedIds.dimensions.condition.dimensionId, optionId }],
        },
        { policyId: "pol_1", policyVersion: 1, effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: null },
      );
      expect(result.requirements.requiredSlots).toEqual([
        expect.objectContaining({ slotId: "condition", viewKind: "condition" }),
      ]);
      expect(result.matchedRuleIds).toContain(optionId.endsWith("pristine") ? "condition-pristine" : "condition-mint");
    }
  });

  it("resolves typed slab/front/back requirements for the graded-item trait", () => {
    const result = evaluateListingEvidencePolicy(
      LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
      { ...baseFacts, gradedItem: true },
      { policyId: "pol_1", policyVersion: 1, effectiveFrom: null, effectiveUntil: null },
    );
    expect(result.requirements.minimumPhotoCount).toBe(3);
    expect(result.requirements.requiredSlots.map((slot) => slot.viewKind)).toEqual(["back", "front", "slab"]);
  });

  it("represents the high-dollar photo and seller-trust thresholds as policy data", () => {
    const below = evaluateListingEvidencePolicy(
      LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
      { ...baseFacts, priceAmount: "249.99" },
      { policyId: null, policyVersion: null, effectiveFrom: null, effectiveUntil: null },
    );
    const at = evaluateListingEvidencePolicy(
      LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
      { ...baseFacts, priceAmount: "250.00" },
      { policyId: "pol_1", policyVersion: 1, effectiveFrom: null, effectiveUntil: null },
    );
    expect(below.matchedRuleIds).not.toContain("high-dollar-evidence");
    expect(at.requirements.minimumPhotoCount).toBe(1);
    expect(at.requirements.sellerTrustRequirements).toEqual([
      {
        ruleId: "high-dollar-evidence",
        satisfaction: "any",
        minimumReviewCount: 3,
        acceptedBadgeKeys: ["trusted-seller"],
      },
    ]);
  });

  it("combines additive requirements deterministically and returns an auditable explanation", () => {
    const result = evaluateListingEvidencePolicy(
      LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
      {
        ...baseFacts,
        gradedItem: true,
        priceAmount: "750.00",
        selectedOptions: [
          {
            dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
            optionId: catalogSeedIds.dimensions.condition.optionIds.mint,
          },
        ],
      },
      { policyId: "pol_1", policyVersion: 7, effectiveFrom: "2026-07-13T00:00:00.000Z", effectiveUntil: null },
    );
    expect(result.matchedRuleIds).toEqual(["condition-mint", "graded-item-views", "high-dollar-evidence"]);
    expect(result.policyId).toBe("pol_1");
    expect(result.policyVersion).toBe(7);
    expect(result.policyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.effectiveInterval.from).toBe("2026-07-13T00:00:00.000Z");
  });

  it("rejects conflicting slots and invalid price bands with actionable diagnostics", () => {
    const conflicting = {
      ...LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
      lifecycle: "draft" as const,
      rules: [
        ...LISTING_EVIDENCE_LAUNCH_POLICY_VALUE.rules,
        {
          ...LISTING_EVIDENCE_LAUNCH_POLICY_VALUE.rules[0]!,
          ruleId: "conflicting-rule",
          outcome: {
            ...LISTING_EVIDENCE_LAUNCH_POLICY_VALUE.rules[0]!.outcome,
            requiredSlots: [
              {
                slotId: "condition",
                viewKind: "back",
                minimumWidthPixels: null,
                minimumHeightPixels: null,
                maximumAgeHours: null,
              },
            ],
          },
        },
      ],
    };
    expect(validateListingEvidencePolicy(conflicting)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "conflicting_policy_slot" })]),
    );
    expect(() =>
      decodeListingEvidencePolicyValue({
        ...LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
        rules: [
          {
            ...LISTING_EVIDENCE_LAUNCH_POLICY_VALUE.rules[0],
            selector: {
              ...LISTING_EVIDENCE_LAUNCH_POLICY_VALUE.rules[0]!.selector,
              priceBand: { minimumAmount: "500.00", maximumAmount: "100.00" },
            },
          },
        ],
      }),
    ).toThrow(/maximum must be greater/);
  });

  it("produces the same hash after a JSON round trip and label-independent evaluation", () => {
    const decoded = decodeListingEvidencePolicyValue(JSON.parse(JSON.stringify(LISTING_EVIDENCE_LAUNCH_POLICY_VALUE)));
    expect(listingEvidencePolicyHash(decoded)).toBe(listingEvidencePolicyHash(LISTING_EVIDENCE_LAUNCH_POLICY_VALUE));
    expect(JSON.stringify(decoded)).not.toMatch(/\"Mint\"|\"Pristine\"/);
  });
});
