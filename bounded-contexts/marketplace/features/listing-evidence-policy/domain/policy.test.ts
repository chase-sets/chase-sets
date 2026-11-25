import { describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { JsonValue } from "@chase-sets/primitives/json";
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

/** A document as an environment stored it before the Certificate Number Format member existed. */
const storedDocumentWithoutCertificateFormat = {
  schemaVersion: 1,
  policyName: "Stored before Certificate Number Format",
  lifecycle: "active",
  sourcePolicyDocumentId: "pol_source",
  validation: {
    validatedAt: "2026-07-13T00:00:00.000Z",
    policyHash: "sha256:validated",
    impactPreviewHash: "sha256:preview",
  },
  rules: [
    {
      ruleId: "graded-psa-views",
      explanationCode: "listing-evidence.graded-item",
      priority: 10,
      selector: {
        catalogItemIds: [],
        productIds: [],
        blueprintIds: [],
        categoryIds: ["ctg_1"],
        options: [{ dimensionId: "dim_seed_grading_company", optionId: "chc_seed_grading_company_psa" }],
        gradedItem: true,
        priceBand: { minimumAmount: "25.00", maximumAmount: null },
        seller: { minimumReviewCount: null, badgeKeys: [], riskLevels: [] },
      },
      outcome: {
        minimumPhotoCount: 2,
        requiredSlots: [
          {
            slotId: "slab",
            viewKind: "slab",
            minimumWidthPixels: 800,
            minimumHeightPixels: null,
            maximumAgeHours: null,
          },
        ],
        sellerTrust: { satisfaction: "any", minimumReviewCount: 3, acceptedBadgeKeys: ["trusted-seller"] },
        buyerAcknowledgment: "required",
      },
    },
    { ruleId: "any-listing", explanationCode: "listing-evidence.any", selector: {}, outcome: {} },
  ],
};

const gradedRule = storedDocumentWithoutCertificateFormat.rules[0];
const psaRange = { minimumDigits: 8, maximumDigits: 10 };

function documentWithCertificateNumber(certificateNumber: JsonValue, selector: JsonValue = gradedRule.selector) {
  return {
    ...storedDocumentWithoutCertificateFormat,
    rules: [{ ...gradedRule, selector, outcome: { ...gradedRule.outcome, certificateNumber } }],
  };
}

describe("Certificate Number Format on a stored Listing Evidence Policy document", () => {
  it("decodes a document without the member to outcomes without the key and to the hash it had before", () => {
    const decoded = decodeListingEvidencePolicyValue(storedDocumentWithoutCertificateFormat);

    for (const rule of decoded.rules) expect(Object.keys(rule.outcome)).not.toContain("certificateNumber");
    expect(JSON.stringify(decoded)).not.toContain("certificateNumber");
    // Computed from this document before the member existed.
    expect(listingEvidencePolicyHash(decoded)).toBe(
      "sha256:d5b4ec9cdabc8fd6869167fdd146218d41cf14cd499e35fffd811d5c4ce4531e",
    );
  });

  it("decodes a null member as an absent one, never as a null key", () => {
    const decoded = decodeListingEvidencePolicyValue({
      ...storedDocumentWithoutCertificateFormat,
      rules: storedDocumentWithoutCertificateFormat.rules.map((rule) => ({
        ...rule,
        outcome: { ...rule.outcome, certificateNumber: null },
      })),
    });

    for (const rule of decoded.rules) expect(Object.keys(rule.outcome)).not.toContain("certificateNumber");
    expect(listingEvidencePolicyHash(decoded)).toBe(
      listingEvidencePolicyHash(decodeListingEvidencePolicyValue(storedDocumentWithoutCertificateFormat)),
    );
  });

  it("round-trips a rule that carries the member and gives it a hash of its own", () => {
    const decoded = decodeListingEvidencePolicyValue(documentWithCertificateNumber(psaRange));
    const again = decodeListingEvidencePolicyValue(JSON.parse(JSON.stringify(decoded)));

    expect(decoded.rules[0]!.outcome.certificateNumber).toEqual(psaRange);
    expect(again).toEqual(decoded);
    expect(listingEvidencePolicyHash(again)).toBe(listingEvidencePolicyHash(decoded));
    expect(listingEvidencePolicyHash(decoded)).not.toBe(
      listingEvidencePolicyHash(
        decodeListingEvidencePolicyValue({ ...storedDocumentWithoutCertificateFormat, rules: [gradedRule] }),
      ),
    );
    for (const range of [
      { minimumDigits: 1, maximumDigits: 32 },
      { minimumDigits: 9, maximumDigits: 9 },
    ]) {
      const bound = decodeListingEvidencePolicyValue(documentWithCertificateNumber(range));
      expect(bound.rules[0]!.outcome.certificateNumber).toEqual(range);
    }
  });

  it.each([
    ["a minimum below 1", { minimumDigits: 0, maximumDigits: 10 }, /minimumDigits must be a whole number from 1 to 32/],
    [
      "a maximum above 32",
      { minimumDigits: 8, maximumDigits: 33 },
      /maximumDigits must be a whole number from 1 to 32/,
    ],
    ["a fractional count", { minimumDigits: 8.5, maximumDigits: 10 }, /minimumDigits must be a whole number/],
    [
      "a minimum above its maximum",
      { minimumDigits: 10, maximumDigits: 8 },
      /cannot be greater than its maximumDigits/,
    ],
    ["a missing maximum", { minimumDigits: 8 }, /maximumDigits must be a whole number from 1 to 32/],
    ["a pattern in place of a range", "^[0-9]{8,10}$", /certificateNumber must be an object/],
  ] as const)("rejects %s", (_label, certificateNumber, message) => {
    expect(() => decodeListingEvidencePolicyValue(documentWithCertificateNumber(certificateNumber))).toThrow(message);
  });

  it("rejects a rule that carries the member and selects no Option", () => {
    const unkeyed = documentWithCertificateNumber(psaRange, { ...gradedRule.selector, options: [] });

    expect(() => decodeListingEvidencePolicyValue(unkeyed)).toThrow(
      "Rule 'graded-psa-views' sets a Certificate Number Format and must select at least one Option.",
    );
    const keyed = decodeListingEvidencePolicyValue(documentWithCertificateNumber(psaRange));
    const rule = keyed.rules[0]!;
    expect(
      validateListingEvidencePolicy({ ...keyed, rules: [{ ...rule, selector: { ...rule.selector, options: [] } }] }),
    ).toEqual([
      expect.objectContaining({ code: "certificate_format_without_option", path: "rules[0].selector.options" }),
    ]);
    expect(validateListingEvidencePolicy(keyed)).toEqual([]);
    // The same empty selection is allowed on a rule that sets no format.
    expect(
      validateListingEvidencePolicy(decodeListingEvidencePolicyValue(storedDocumentWithoutCertificateFormat)),
    ).toEqual([]);
  });
});

describe("Certificate Number Formats of the launch policy", () => {
  const { form, gradingCompany, grade, condition } = catalogSeedIds.dimensions;
  const metadata = { policyId: null, policyVersion: null, effectiveFrom: null, effectiveUntil: null };
  const gradedFacts = (company: keyof typeof gradingCompany.optionIds) => ({
    ...baseFacts,
    gradedItem: true,
    selectedOptions: [
      { dimensionId: form.dimensionId, optionId: form.optionIds.graded },
      { dimensionId: gradingCompany.dimensionId, optionId: gradingCompany.optionIds[company] },
      { dimensionId: grade.dimensionId, optionId: grade.optionIds.gemMint10 },
    ],
  });
  const rawFacts = {
    ...baseFacts,
    selectedOptions: [
      { dimensionId: form.dimensionId, optionId: form.optionIds.raw },
      { dimensionId: condition.dimensionId, optionId: condition.optionIds.nearMint },
    ],
  };
  const rulesBeforeCertificateFormats = LISTING_EVIDENCE_LAUNCH_POLICY_VALUE.rules.filter(
    (rule) => !rule.ruleId.startsWith("certificate-format-"),
  );

  it.each([
    ["psa", 8, 10],
    ["bgs", 8, 10],
    ["cgc", 7, 10],
    ["sgc", 6, 10],
  ] as const)("returns the %s range for a selection with that Option", (company, minimumDigits, maximumDigits) => {
    const result = evaluateListingEvidencePolicy(LISTING_EVIDENCE_LAUNCH_POLICY_VALUE, gradedFacts(company), metadata);

    expect(result.certificateNumberFormats).toEqual([{ minimumDigits, maximumDigits }]);
    expect(result.matchedRuleIds).toEqual(["graded-item-views", `certificate-format-${company}`]);
    expect(result.explanationCodes).toEqual(["listing-evidence.graded-item", "listing-evidence.certificate-format"]);
  });

  it.each(["ace", "tag"] as const)("returns no format for a selection with the %s Option", (company) => {
    const result = evaluateListingEvidencePolicy(LISTING_EVIDENCE_LAUNCH_POLICY_VALUE, gradedFacts(company), metadata);

    expect(result.certificateNumberFormats).toEqual([]);
    expect(result.matchedRuleIds).toEqual(["graded-item-views"]);
  });

  it("returns no format for a raw selection", () => {
    const result = evaluateListingEvidencePolicy(LISTING_EVIDENCE_LAUNCH_POLICY_VALUE, rawFacts, metadata);

    expect(result.certificateNumberFormats).toEqual([]);
    expect(result.matchedRuleIds).toEqual([]);
  });

  it("keeps the formats out of the resolved requirements", () => {
    for (const company of ["psa", "bgs", "cgc", "sgc"] as const) {
      const result = evaluateListingEvidencePolicy(
        LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
        gradedFacts(company),
        metadata,
      );
      const before = evaluateListingEvidencePolicy(
        { ...LISTING_EVIDENCE_LAUNCH_POLICY_VALUE, rules: rulesBeforeCertificateFormats },
        gradedFacts(company),
        metadata,
      );

      expect(Object.keys(result.requirements).sort()).toEqual([
        "buyerAcknowledgment",
        "minimumPhotoCount",
        "requiredSlots",
        "sellerTrustRequirements",
      ]);
      expect(JSON.stringify(result.requirements)).not.toMatch(/certificateNumber|Digits/);
      expect(result.requirements).toEqual(before.requirements);
    }
  });

  it("returns one entry for every matched rule that carries the member", () => {
    const launchPsaRule = LISTING_EVIDENCE_LAUNCH_POLICY_VALUE.rules.find(
      (rule) => rule.ruleId === "certificate-format-psa",
    )!;
    const nineDigits = { minimumDigits: 9, maximumDigits: 9 };
    const narrower = {
      ...launchPsaRule,
      ruleId: "certificate-format-psa-nine",
      priority: 900,
      outcome: { ...launchPsaRule.outcome, certificateNumber: nineDigits },
    };

    const result = evaluateListingEvidencePolicy(
      { ...LISTING_EVIDENCE_LAUNCH_POLICY_VALUE, rules: [...LISTING_EVIDENCE_LAUNCH_POLICY_VALUE.rules, narrower] },
      gradedFacts("psa"),
      metadata,
    );

    expect(result.certificateNumberFormats).toEqual([psaRange, nineDigits]);
  });

  it("adds exactly four rules, each keyed by one Grading Company Option and setting nothing else", () => {
    expect(LISTING_EVIDENCE_LAUNCH_POLICY_VALUE.rules.map((rule) => rule.ruleId)).toEqual([
      "condition-mint",
      "condition-pristine",
      "graded-item-views",
      "high-dollar-evidence",
      "certificate-format-psa",
      "certificate-format-bgs",
      "certificate-format-cgc",
      "certificate-format-sgc",
    ]);
    for (const company of ["psa", "bgs", "cgc", "sgc"] as const) {
      const rule = LISTING_EVIDENCE_LAUNCH_POLICY_VALUE.rules.find(
        (candidate) => candidate.ruleId === `certificate-format-${company}`,
      )!;
      const { certificateNumber, ...otherOutcome } = rule.outcome;
      expect(certificateNumber).toBeDefined();
      expect(rule.explanationCode).toBe("listing-evidence.certificate-format");
      expect(rule.selector).toEqual({
        catalogItemIds: [],
        productIds: [],
        blueprintIds: [],
        categoryIds: [],
        options: [{ dimensionId: gradingCompany.dimensionId, optionId: gradingCompany.optionIds[company] }],
        gradedItem: null,
        priceBand: null,
        seller: { minimumReviewCount: null, badgeKeys: [], riskLevels: [] },
      });
      expect(otherOutcome).toEqual({
        minimumPhotoCount: 0,
        requiredSlots: [],
        sellerTrust: null,
        buyerAcknowledgment: "none",
      });
    }
    expect(validateListingEvidencePolicy(LISTING_EVIDENCE_LAUNCH_POLICY_VALUE)).toEqual([]);
    expect(decodeListingEvidencePolicyValue(JSON.parse(JSON.stringify(LISTING_EVIDENCE_LAUNCH_POLICY_VALUE)))).toEqual(
      LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
    );
  });

  it("changes the launch hash by the four rules alone", () => {
    // The launch value's hash before the four Certificate Number Format rules were added.
    const hashBeforeCertificateFormats = "sha256:c2b91e910cfc256c2c53e36e8ebc773eefb30b182ddc96f943e50c4e685c8001";

    expect(rulesBeforeCertificateFormats).toHaveLength(4);
    expect(listingEvidencePolicyHash({ schemaVersion: 1, rules: rulesBeforeCertificateFormats })).toBe(
      hashBeforeCertificateFormats,
    );
    expect(listingEvidencePolicyHash(LISTING_EVIDENCE_LAUNCH_POLICY_VALUE)).not.toBe(hashBeforeCertificateFormats);
  });
});
