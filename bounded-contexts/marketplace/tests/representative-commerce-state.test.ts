import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogRepresentativeCatalogUsageCandidate } from "@chase-sets/catalog-seed";
import { describe, expect, it } from "vitest";
import {
  acceptRepresentativeOffers,
  filterUntouchedMarketplaceCatalogUsageCandidates,
  loadUntouchedMarketplaceCatalogUsageCandidates,
  normalizeRepresentativeCandidateLimit,
  reconcileRepresentativeMarketplaceCatalogItems,
  submitRepresentativeOffers,
} from "../support/seed-support/representative-commerce-state";

describe("marketplace representative commerce state", () => {
  it("loads active marketplace catalog items that do not already have listings or offers", async () => {
    const queries: unknown[][] = [];
    const rows = [
      {
        catalog_item_id: "cat_real_1",
        title: "Real Imported Card",
        subtitle: "Provider expansion 12/123",
        blueprint_id: "bp_card",
        updated_at: "2026-05-27T00:00:00.000Z",
      },
    ];
    const db: Pick<PgQueryable, "query"> = {
      query: async <Row>(sql: string, params?: readonly unknown[]) => {
        queries.push([sql, params]);
        return {
          rows: rows as Row[],
          rowCount: rows.length,
        };
      },
    };

    const candidates = await loadUntouchedMarketplaceCatalogUsageCandidates(db, { limit: 25 });

    expect(candidates).toEqual([
      {
        catalogItemId: "cat_real_1",
        title: "Real Imported Card",
        subtitle: "Provider expansion 12/123",
        blueprintId: "bp_card",
        updatedAt: "2026-05-27T00:00:00.000Z",
      },
    ]);
    expect(String(queries[0]?.[0])).toContain("FROM marketplace_catalog_items item");
    expect(String(queries[0]?.[0])).toContain("jsonb_array_length(item.product_measure_snapshots)");
    expect(String(queries[0]?.[0])).toContain("LEFT JOIN marketplace_listing_pages listing");
    expect(String(queries[0]?.[0])).toContain("LEFT JOIN marketplace_offer_pages offer");
    expect(queries[0]?.[1]).toEqual([25]);
  });

  it("keeps representative item limits bounded", () => {
    expect(normalizeRepresentativeCandidateLimit(undefined)).toBe(50);
    expect(normalizeRepresentativeCandidateLimit(0)).toBe(50);
    expect(normalizeRepresentativeCandidateLimit(1.8)).toBe(1);
    expect(normalizeRepresentativeCandidateLimit(800)).toBe(500);
  });

  it("filters current Catalog candidates to items untouched by Marketplace usage", async () => {
    const queries: unknown[][] = [];
    const db: Pick<PgQueryable, "query"> = {
      query: async <Row>(sql: string, params?: readonly unknown[]) => {
        queries.push([sql, params]);
        return {
          rows: [{ catalog_item_id: "cat_touched_1" }] as Row[],
          rowCount: 1,
        };
      },
    };
    const candidates = [
      representativeCatalogCandidate("cat_touched_1"),
      representativeCatalogCandidate("cat_untouched_1"),
      representativeCatalogCandidate("cat_untouched_2"),
    ];

    await expect(filterUntouchedMarketplaceCatalogUsageCandidates(db, candidates, { limit: 1 })).resolves.toEqual([
      representativeCatalogCandidate("cat_untouched_1"),
    ]);
    expect(String(queries[0]?.[0])).toContain("FROM marketplace_listing_pages listing");
    expect(String(queries[0]?.[0])).toContain("FROM marketplace_offer_pages offer");
    expect(queries[0]?.[1]).toEqual([["cat_touched_1", "cat_untouched_1", "cat_untouched_2"]]);
  });

  it("reconciles selected current Catalog candidates into the Marketplace catalog projection", async () => {
    const queries: unknown[][] = [];
    const db: Pick<PgQueryable, "query"> = {
      query: async <Row>(sql: string, params?: readonly unknown[]) => {
        queries.push([sql, params]);
        return { rows: [] as Row[], rowCount: 1 };
      },
    };

    await expect(
      reconcileRepresentativeMarketplaceCatalogItems(db, [representativeCatalogCandidate("cat_real_1")]),
    ).resolves.toBe(1);

    expect(String(queries[0]?.[0])).toContain("INSERT INTO marketplace_catalog_items");
    expect(queries[0]?.[1]).toEqual([
      "cat_real_1",
      "en",
      "Real Imported Card",
      "Provider expansion 12/123",
      "bp_card",
      "active",
      JSON.stringify([{ productId: "cat_real_1::" }]),
      JSON.stringify({ canonicalDimensionOrder: [], dimensions: [] }),
      "2026-05-27T00:00:00.000Z",
    ]);
  });

  it("submits representative offers with stable ids for current catalog stock", async () => {
    const submitted: unknown[] = [];
    const services = {
      db: {
        query: async <Row>(sql: string) => {
          if (sql.includes("FROM marketplace_offer_pages")) {
            return { rows: [] as Row[], rowCount: 0 };
          }

          return {
            rows: [
              {
                title: "Real Imported Card",
                subtitle: "Provider expansion 12/123",
                status: "active",
                product_schema: null,
              },
            ] as Row[],
            rowCount: 1,
          };
        },
      },
      offers: {
        submitOffer: async (params: unknown) => {
          submitted.push(params);
          return { offerId: (params as { offerId: string }).offerId, version: 1 };
        },
      },
    };

    const offers = await submitRepresentativeOffers(services as never, [
      {
        catalogItemId: "cat_real_1",
        accountId: "acc_repr_card_vault_account",
        inventoryItemId: "inv_repr_1",
        selectedOptions: [],
        totalQuantity: 4,
      },
    ]);

    expect(offers).toEqual([
      expect.objectContaining({
        catalogItemId: "cat_real_1",
        buyerAccountId: "acc_repr_staging_collector_account",
        status: "created",
      }),
    ]);
    expect(submitted).toEqual([
      expect.objectContaining({
        catalogItemId: "cat_real_1",
        productId: "cat_real_1::",
        itemTitle: "Real Imported Card",
        quantityRequested: 1,
      }),
    ]);
  });

  it("accepts submitted representative offers with current fee quotes", async () => {
    const accepted: unknown[] = [];
    const services = {
      db: {
        query: async <Row>() => ({
          rows: [{ status: "submitted" }] as Row[],
          rowCount: 1,
        }),
      },
      offers: {
        previewOfferAcceptanceTerms: async () => ({ fee_quote_fingerprint: "fee_1" }),
        acceptOffer: async (params: unknown) => {
          accepted.push(params);
          return { offerId: (params as { offerId: string }).offerId, version: 2 };
        },
      },
    };

    const results = await acceptRepresentativeOffers(services as never, [
      {
        catalogItemId: "cat_real_1",
        accountId: "acc_repr_card_vault_account",
        inventoryItemId: "inv_repr_1",
        selectedOptions: [],
        totalQuantity: 4,
      },
    ]);

    expect(results).toEqual([
      expect.objectContaining({
        catalogItemId: "cat_real_1",
        sellerAccountId: "acc_repr_card_vault_account",
        status: "accepted",
      }),
    ]);
    expect(accepted).toEqual([
      expect.objectContaining({
        sellerAccountId: "acc_repr_card_vault_account",
        feeQuoteFingerprint: "fee_1",
      }),
    ]);
  });
});

function representativeCatalogCandidate(catalogItemId: string): CatalogRepresentativeCatalogUsageCandidate {
  return {
    catalogItemId,
    languageCode: "en",
    title: "Real Imported Card",
    subtitle: "Provider expansion 12/123",
    blueprintId: "bp_card",
    status: "active",
    productSchema: { canonicalDimensionOrder: [], dimensions: [] },
    productMeasureSnapshots: [{ productId: `${catalogItemId}::` } as never],
    updatedAt: "2026-05-27T00:00:00.000Z",
  };
}
