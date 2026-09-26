import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { listProviderSaleEvidence } from "../read-model/provider-observation-queries";

const params = {
  providerKey: "tcgplayer",
  catalogItemId: "cat_synthetic",
  soldSince: "2026-08-01T00:00:00.000Z",
  soldUntil: "2026-09-03T00:00:00.000Z",
};

describe("provider sale evidence coverage", () => {
  it.each([
    [["complete", "unknown"], "unknown"],
    [["unknown", "complete"], "unknown"],
    [["unknown", "request-cap-truncated"], "unknown"],
    [["request-cap-truncated", "unknown"], "unknown"],
    [["unknown"], "unknown"],
    [["complete", "complete"], "complete-capture"],
    [["complete", "request-cap-truncated"], "truncated-capture"],
    [["complete", "page-budget-truncated"], "truncated-capture"],
    [["inconsistent"], "unknown"],
    [["complete", "inconsistent"], "unknown"],
    [["inconsistent", "request-cap-truncated"], "unknown"],
    [[null], "unknown"],
    [[null, "complete"], "unknown"],
    [[null, "request-cap-truncated"], "truncated-capture"],
  ] as const)("preserves unknown sale coverage before truncation: %j", async (coverages, coverage) => {
    const rows = coverages.map((sales_coverage, index) => ({
      sale_fingerprint: "synthetic-tuple",
      observed_occurrence_count: index + 2,
      provider_condition: "Near Mint",
      provider_variant: "Normal",
      provider_language: "English",
      listing_type: "ListingWithoutPhotos",
      sold_at: "2026-08-31T12:00:00.000Z",
      quantity: 1,
      unit_price: "5.39",
      order_shipping: "1.00",
      capture_id: `synthetic-capture-${index}`,
      capture_started_at: `2026-09-0${index + 1}T15:00:00.000Z`,
      currency: "USD",
      observation_policy_revision_id: "synthetic-policy-r1",
      sales_coverage,
    }));
    const db = { query: async () => ({ rows }) } as unknown as PgQueryable;
    expect(await listProviderSaleEvidence(db, params)).toEqual([
      {
        saleFingerprint: "synthetic-tuple",
        providerCondition: "Near Mint",
        providerVariant: "Normal",
        providerLanguage: "English",
        listingType: "ListingWithoutPhotos",
        soldAt: "2026-08-31T12:00:00.000Z",
        quantity: 1,
        unitPrice: "5.39",
        orderShipping: "1.00",
        maxObservedTupleMultiplicity: coverages.length + 1,
        countSemantics: "provider-returned-max-per-capture",
        captureIds: coverages.map((_, index) => `synthetic-capture-${index}`),
        captureStartedAt: `2026-09-0${coverages.length}T15:00:00.000Z`,
        currency: "USD",
        policyRevisionId: "synthetic-policy-r1",
        coverage,
      },
    ]);
  });

  it("returns no evidence when the query has no sale rows", async () => {
    const db = { query: async () => ({ rows: [] }) } as unknown as PgQueryable;
    expect(await listProviderSaleEvidence(db, params)).toEqual([]);
  });
});
