import { describe, expect, it, vi } from "vitest";
import {
  buildChannelCategorySourceKeys,
  buildChannelConditionSourceKeys,
  buildChannelGradedAttributeSourceEntries,
  createChannelCompositionProfileRegistry,
  deriveChannelListingId,
  deriveChannelSelectedOptionKey,
} from "../domain/canonical";
import { composeChannelListingPublication } from "../domain/compose";
import {
  channelPublicationBlockingReasons,
  channelPublicationConfigurationBlockingReasons,
  channelPublicationListingBlockingReasons,
  type ChannelListingCompositionInput,
} from "../domain/contracts";
import { parseChannelListingCompositionInput } from "../domain/parse";
import { readChannelMappingReviewQueue } from "../read-model/queries";
import { listingInput, publishedLink, syntheticProfile } from "./test-support";

describe("channel-listing-composition-purity", () => {
  it("is deterministic and isolated from independent profile registries", () => {
    const input = listingInput();
    const first = composeChannelListingPublication(input);
    const second = composeChannelListingPublication(structuredClone(input));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const empty = createChannelCompositionProfileRegistry();
    const registered = createChannelCompositionProfileRegistry([syntheticProfile]);
    expect(empty.get(syntheticProfile.identity)).toBeNull();
    expect(registered.get(syntheticProfile.identity)).toEqual(syntheticProfile);
    expect(composeChannelListingPublication(input)).toEqual(first);
  });
});

describe("channel-listing-marketplace-price-source-contract", () => {
  it("changes currency and desired hash without deriving a default", () => {
    const usd = composeChannelListingPublication(listingInput());
    const eurInput = listingInput();
    const listing = present(eurInput);
    const eur = composeChannelListingPublication(
      listingInput({
        listing: {
          ...listing,
          offer: { ...listing.offer, price: { kind: "present", amount: "20.00", currencyCode: "EUR" } },
        },
      }),
    );
    expect(usd).toMatchObject({ kind: "publishable", draft: { price: { amountMinor: 2_000, currency: "USD" } } });
    expect(eur).toMatchObject({ kind: "publishable", draft: { price: { amountMinor: 2_000, currency: "EUR" } } });
    if (usd.kind !== "publishable" || eur.kind !== "publishable") throw new Error("Expected publishable controls.");
    expect(usd.desiredStateHash).not.toBe(eur.desiredStateHash);
    const missing = composeChannelListingPublication(
      listingInput({
        listing: { ...listing, offer: { ...listing.offer, price: { kind: "absent" } } },
      }),
    );
    expect(missing).toEqual({ kind: "blocked", reasons: ["missing-price"] });
  });
});

describe("channel-listing-composition-input-closure", () => {
  it("rejects nested unknown keys, duplicate mappings, invalid instants and bounds", () => {
    expect(parseChannelListingCompositionInput(listingInput())).toMatchObject({ kind: "valid" });
    const unknown = structuredClone(listingInput()) as ChannelListingCompositionInput & { extra?: boolean };
    unknown.extra = true;
    expect(parseChannelListingCompositionInput(unknown)).toEqual({ kind: "invalid", programmingError: "unknown-key" });
    const duplicate = listingInput({ mappings: [...listingInput().mappings, listingInput().mappings[0]!] });
    expect(parseChannelListingCompositionInput(duplicate)).toEqual({
      kind: "invalid",
      programmingError: "mapping-duplicate-source-key",
    });
    const mismatch = listingInput({
      profile: {
        kind: "registered",
        profile: { ...syntheticProfile, identity: { ...syntheticProfile.identity, providerKey: "other" } },
      },
    });
    expect(parseChannelListingCompositionInput(mismatch)).toEqual({
      kind: "invalid",
      programmingError: "profile-identity-mismatch",
    });
    expect(() =>
      createChannelCompositionProfileRegistry([
        { ...syntheticProfile, derivation: { ...syntheticProfile.derivation, capturedAt: "" } },
      ]),
    ).toThrow();
  });
});

describe("channel-listing-composition-draft-fields", () => {
  it("enforces every profile bound and keeps allowed currency as validation only", () => {
    const listing = present(listingInput());
    const unsupported = composeChannelListingPublication(
      listingInput({
        listing: {
          ...listing,
          offer: { ...listing.offer, price: { kind: "present", amount: "20.00", currencyCode: "GBP" } },
        },
      }),
    );
    expect(unsupported).toEqual({ kind: "blocked", reasons: ["invalid-currency"] });
    const over = composeChannelListingPublication(
      listingInput({
        profile: {
          kind: "registered",
          profile: { ...syntheticProfile, price: { ...syntheticProfile.price, maxAmountMinor: 1_999 } },
        },
      }),
    );
    expect(over).toEqual({ kind: "blocked", reasons: ["price-out-of-range"] });
    const tooMany = composeChannelListingPublication(
      listingInput({
        listing: { ...listing, offer: { ...listing.offer, publishableQuantity: { kind: "resolved", value: 101 } } },
      }),
    );
    expect(tooMany).toEqual({ kind: "blocked", reasons: ["quantity-out-of-range"] });
  });

  it("R8 rejects the unconstrained profile-to-port mutant for every draft ceiling", () => {
    const invalidProfiles = [
      { ...syntheticProfile, title: { ...syntheticProfile.title, maxLength: 4_097 } },
      { ...syntheticProfile, description: { ...syntheticProfile.description, maxLength: 100_001 } },
      { ...syntheticProfile, category: { ...syntheticProfile.category, maxKeyLength: 257 } },
      { ...syntheticProfile, condition: { ...syntheticProfile.condition, maxKeyLength: 257 } },
      { ...syntheticProfile, attributes: { ...syntheticProfile.attributes, maxCount: 201 } },
      { ...syntheticProfile, attributes: { ...syntheticProfile.attributes, maxKeyLength: 257 } },
      { ...syntheticProfile, attributes: { ...syntheticProfile.attributes, maxValueLength: 4_097 } },
      { ...syntheticProfile, quantity: { ...syntheticProfile.quantity, max: 1_000_001 } },
    ];
    for (const profile of invalidProfiles) {
      expect(() => createChannelCompositionProfileRegistry([profile])).toThrow(
        "bounds exceed the Channel Publication Draft contract",
      );
    }

    const listing = present(listingInput());
    const bypassedRegistration = listingInput({
      profile: {
        kind: "registered",
        profile: { ...syntheticProfile, title: { ...syntheticProfile.title, maxLength: 5_000 } },
      },
      listing: {
        ...listing,
        identity: { ...listing.identity, itemTitle: { kind: "present", value: "x".repeat(4_097) } },
      },
    });
    expect(() => composeChannelListingPublication(bypassedRegistration)).toThrow(
      "composed Channel Publication Draft.title must contain 1 to 4096 Unicode scalars",
    );
  });
});

describe("channel-composition-dimension-modes", () => {
  it("reads no mappings for snapshot-preserved dimensions and mapped dimensions fail closed", () => {
    const snapshotProfile = {
      ...syntheticProfile,
      category: { mode: "snapshot-preserved" as const, maxKeyLength: 100, snapshotField: "category" },
      condition: { mode: "snapshot-preserved" as const, maxKeyLength: 100, snapshotField: "condition" },
      mappings: undefined,
    };
    const snapshot = composeChannelListingPublication(
      listingInput({
        profile: { kind: "registered", profile: snapshotProfile },
        mappings: [],
      }),
    );
    expect(snapshot).toMatchObject({
      kind: "publishable",
      draft: {
        categoryKey: syntheticProfile.snapshotPreservedPlaceholder,
        conditionKey: syntheticProfile.snapshotPreservedPlaceholder,
        attributes: [],
      },
    });
    expect(composeChannelListingPublication(listingInput({ mappings: [] }))).toEqual({
      kind: "blocked",
      reasons: ["category-unmapped", "condition-unmapped"],
    });
  });
});

describe("channel-listing-source-key-derivation", () => {
  it("derives scalar-sorted categories, exclusive condition sources and the full graded order", () => {
    expect(buildChannelCategorySourceKeys(["z", "😀", "a"])).toEqual([
      "catalog-category:a",
      "catalog-category:z",
      "catalog-category:😀",
    ]);
    const graded = {
      gradingCompany: "PSA",
      grade: "10",
      certificationNumber: "cert",
      population: { populationAtGrade: 2, populationHigher: 1, source: "source", asOf: "2026-09-08" },
      conditionDescriptors: ["first", "second"],
    };
    expect(
      buildChannelConditionSourceKeys([{ dimensionId: "condition", optionId: "nm" }], graded, "condition"),
    ).toHaveLength(2);
    expect(buildChannelGradedAttributeSourceEntries(graded).map((entry) => entry.sourceKey)).toEqual([
      "graded:grading-company",
      "graded:grade",
      "graded:certification-number",
      "graded:population-at-grade",
      "graded:population-higher",
      "graded:population-source",
      "graded:population-as-of",
      "graded:condition-descriptor:0",
      "graded:condition-descriptor:1",
    ]);
  });
});

describe("channel-mapping-review-snapshot", () => {
  it("R6 rejects the two-statement snapshot-interleaving mutant", async () => {
    const query = vi.fn(async (_sql: string) => ({
      rows: [
        {
          page_rows: [
            {
              connection_id: "connection-synthetic",
              dimension: "category",
              source_key: "catalog-category:cards",
              target_key: null,
              confidence_tier: "high",
              review_status: "proposed",
              provenance: "compose-discovered",
              evidence: { listingId: "listing-synthetic", derivedFrom: "snapshot" },
              last_stream_version: 1,
            },
          ],
          total: 1,
        },
      ],
    }));
    await expect(
      readChannelMappingReviewQueue({ query } as never, { connectionId: "connection-synthetic" }),
    ).resolves.toMatchObject({
      items: [{ sourceKey: "catalog-category:cards" }],
      nextCursor: null,
      completeness: { kind: "complete", total: 1 },
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("WITH queue AS MATERIALIZED");
  });
});

describe("channel-listing-id-derivation", () => {
  it("frames pairs before hashing and preserves the 67-scalar identifier contract", () => {
    const first = deriveChannelListingId("a:b", "c");
    const second = deriveChannelListingId("a", "b:c");
    expect(first).not.toBe(second);
    expect(first).toMatch(/^cl_[a-f0-9]{64}$/);
    expect(Array.from(first)).toHaveLength(67);
    expect(deriveChannelListingId("a:b", "c")).toBe(first);
  });
});

describe("channel-listing-blocking-reason-matrix", () => {
  it("derives the exact disjoint 31-member partition and all four reference absence codes", () => {
    expect(channelPublicationConfigurationBlockingReasons).toHaveLength(8);
    expect(channelPublicationListingBlockingReasons).toHaveLength(23);
    expect(channelPublicationBlockingReasons).toHaveLength(31);
    expect(new Set(channelPublicationBlockingReasons).size).toBe(31);
    const expected = [
      ["providerProductReference", { kind: "unlinked" }, "provider-product-reference-unlinked"],
      ["providerProductReference", { kind: "ambiguous", candidateCount: 2 }, "provider-product-reference-ambiguous"],
      ["providerCatalogItemReference", { kind: "unlinked" }, "provider-catalog-item-reference-unlinked"],
      [
        "providerCatalogItemReference",
        { kind: "ambiguous", candidateCount: 2 },
        "provider-catalog-item-reference-ambiguous",
      ],
    ] as const;
    for (const [field, value, reason] of expected) {
      expect(composeChannelListingPublication(listingInput({ [field]: value }))).toEqual({
        kind: "blocked",
        reasons: [reason],
      });
    }
  });
});

describe("channel-listing-template-validation", () => {
  it("concatenates exactly, blocks absent titles, and delists listing failures from a published Link", () => {
    const input = listingInput();
    const listing = present(input);
    const exact = composeChannelListingPublication(
      listingInput({
        settings: {
          kind: "configured",
          settings: { ...configured(input), titlePrefix: "[", titleSuffix: "]", descriptionFooter: "!" },
        },
      }),
    );
    expect(exact).toMatchObject({
      kind: "publishable",
      draft: { title: "[Synthetic card]", description: "Synthetic description!" },
    });
    const unavailable = composeChannelListingPublication(
      listingInput({
        listing: { ...listing, sellerAvailabilityStatus: "unavailable" },
        link: { kind: "existing", state: publishedLink() },
      }),
    );
    expect(unavailable).toMatchObject({
      kind: "publishable",
      intent: "delist",
      delist: {
        lastPublishedPrice: { amountMinor: 2_000, currency: "USD" },
        lastPublishedQuantity: 3,
        delistReasons: ["seller-unavailable"],
      },
    });
  });
});

describe("channel-selected-option-key", () => {
  it("trims, drops, scalar-sorts and joins from its single implementation", () => {
    expect(
      deriveChannelSelectedOptionKey([
        { dimensionId: " z ", optionId: "2" },
        { dimensionId: "", optionId: "x" },
        { dimensionId: "a", optionId: " 1 " },
      ]),
    ).toBe("a:1|z:2");
  });
});

function present(input: ChannelListingCompositionInput) {
  if (input.listing.kind !== "present") throw new Error("Expected listing facts.");
  return input.listing;
}
function configured(input: ChannelListingCompositionInput) {
  if (input.settings.kind !== "configured") throw new Error("Expected settings.");
  return input.settings.settings;
}
