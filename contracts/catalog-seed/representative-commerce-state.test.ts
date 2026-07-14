import { describe, expect, it } from "vitest";
import {
  acceptRepresentativeOffers,
  filterUntouchedMarketplaceCatalogUsageCandidates,
  loadRepresentativeCatalogUsageCandidates,
  loadUntouchedMarketplaceCatalogUsageCandidates,
  normalizeRepresentativeCandidateLimit,
  normalizeRepresentativeCatalogCandidateLimit,
  prepareRepresentativeCatalogUsageCandidates,
  prepareRepresentativeCatalogUsageCandidatesByIds,
  prioritizeRepresentativeCatalogUsageCandidates,
  reconcileRepresentativeDiscoveryMarketState,
  reconcileRepresentativeInventoryCatalogItems,
  reconcileRepresentativeMarketplaceCatalogItems,
  reconcileRepresentativeOrderingSupplyState,
  selectDefaultRepresentativeOptions,
  submitRepresentativeOffers,
  type CatalogRepresentativeCatalogUsageCandidate,
  type RepresentativeQueryable,
} from "./representative-commerce-state";

type QueryCall = readonly [string, readonly unknown[] | undefined];

describe("representative commerce state seed helpers", () => {
  it("loads active current Catalog Items with resolved product measures and product schema", async () => {
    const queries: QueryCall[] = [];
    const db: RepresentativeQueryable = {
      query: async <Row>(sql: string, params?: readonly unknown[]) => {
        queries.push([sql, params]);

        if (sql.includes("FROM catalog_items item")) {
          return {
            rows: [
              {
                catalog_item_id: "cat_real_1",
                language_code: "en",
                title: "Real Imported Card",
                subtitle: "Provider expansion 12/123",
                blueprint_id: "bp_card",
                status: "active",
                product_measure_snapshots: [
                  {
                    catalogItemId: "cat_real_1",
                    productId: "cat_real_1::dim_form:opt_raw",
                    selectedOptions: [{ dimensionId: "dim_form", optionId: "opt_raw" }],
                  },
                ],
                updated_at: "2026-05-27T00:00:00.000Z",
              },
            ] as Row[],
          };
        }

        if (sql.includes("FROM catalog_blueprints")) {
          return {
            rows: [
              {
                blueprint_id: "bp_card",
                dimension_rules: [{ dimensionId: "dim_form", required: true, allowedOptionIds: ["opt_raw"] }],
                canonical_dimension_order: ["dim_form"],
              },
            ] as Row[],
          };
        }

        if (sql.includes("FROM catalog_dimensions")) {
          return { rows: [{ id: "dim_form", name: "Form" }] as Row[] };
        }

        if (sql.includes("FROM catalog_dimension_options")) {
          return {
            rows: [{ option_id: "opt_raw", code: "raw", label_i18n: null, label: "Raw" }] as Row[],
          };
        }

        return { rows: [] as Row[] };
      },
    };

    const candidates = await loadRepresentativeCatalogUsageCandidates(db, { limit: 25 });

    expect(candidates).toEqual([
      expect.objectContaining({
        catalogItemId: "cat_real_1",
        languageCode: "en",
        status: "active",
        productSchema: {
          canonicalDimensionOrder: [{ dimensionId: "dim_form", dimensionName: "Form" }],
          dimensions: [
            {
              dimensionId: "dim_form",
              dimensionName: "Form",
              required: true,
              appliesWhen: [],
              allowedOptions: [
                {
                  optionId: "opt_raw",
                  code: "raw",
                  label_i18n: { defaultLocale: "en", values: { en: "Raw" } },
                  label: "Raw",
                },
              ],
            },
          ],
        },
      }),
    ]);
    expect(candidates[0]?.productMeasureSnapshots).toHaveLength(1);
    expect(String(queries[0]?.[0])).toContain("JOIN catalog_resolved_product_measures measure");
    expect(String(queries[0]?.[0])).toContain("item.status = 'active'");
    expect(queries[0]?.[1]).toEqual([25]);
  });

  it("keeps representative item limits bounded", () => {
    expect(normalizeRepresentativeCatalogCandidateLimit(undefined)).toBe(50);
    expect(normalizeRepresentativeCatalogCandidateLimit(0)).toBe(50);
    expect(normalizeRepresentativeCandidateLimit(1.8)).toBe(1);
    expect(normalizeRepresentativeCandidateLimit(800)).toBe(500);
  });

  it("resolves a bounded current Catalog Item window before loading measured candidates", async () => {
    const resolvedCatalogItemIds: string[] = [];
    const queries: QueryCall[] = [];
    const db: RepresentativeQueryable = {
      query: async <Row>(sql: string, params?: readonly unknown[]) => {
        queries.push([sql, params]);

        if (sql.includes("SELECT item.catalog_item_id")) {
          return { rows: [{ catalog_item_id: "cat_real_1" }, { catalog_item_id: "cat_real_2" }] as Row[] };
        }

        return { rows: [] as Row[] };
      },
    };

    await prepareRepresentativeCatalogUsageCandidates({
      db,
      productMeasures: {
        resolveCatalogItemMeasures: async (catalogItemId) => {
          resolvedCatalogItemIds.push(catalogItemId);
        },
      },
    });

    expect(resolvedCatalogItemIds).toEqual(["cat_real_1", "cat_real_2"]);
    expect(queries[0]?.[1]).toEqual([50]);
    expect(String(queries[0]?.[0])).toContain("WHERE item.status = 'active'");
    expect(String(queries[0]?.[0])).toContain("NOT EXISTS");
    expect(String(queries[0]?.[0])).toContain("catalog_resolved_product_measures");
  });

  it("fails when a required Product Contents candidate cannot be prepared", async () => {
    await expect(
      prepareRepresentativeCatalogUsageCandidatesByIds(
        {
          db: { query: async <Row>() => ({ rows: [] as Row[] }) },
          productMeasures: { resolveCatalogItemMeasures: async () => undefined },
        },
        ["cat_required_product_contents"],
      ),
    ).rejects.toThrow(
      "Required representative Product Contents Catalog Items are not active with resolved product measures.",
    );
  });

  it("selects raw default required product options from current Catalog product schema", () => {
    expect(
      selectDefaultRepresentativeOptions({
        canonicalDimensionOrder: [
          { dimensionId: "dim_form", dimensionName: "Form" },
          { dimensionId: "dim_grading_company", dimensionName: "Grading Company" },
          { dimensionId: "dim_grade", dimensionName: "Grade" },
          { dimensionId: "dim_condition", dimensionName: "Condition" },
        ],
        dimensions: [
          {
            dimensionId: "dim_form",
            dimensionName: "Form",
            required: true,
            appliesWhen: [],
            allowedOptions: [
              { optionId: "opt_graded", code: "graded", label: "Graded" },
              { optionId: "opt_raw", code: "raw", label: "Raw" },
            ],
          },
          {
            dimensionId: "dim_grading_company",
            dimensionName: "Grading Company",
            required: true,
            appliesWhen: [{ dimensionId: "dim_form", optionIds: ["opt_graded"] }],
            allowedOptions: [{ optionId: "opt_psa", code: "psa", label: "PSA" }],
          },
          {
            dimensionId: "dim_grade",
            dimensionName: "Grade",
            required: true,
            appliesWhen: [{ dimensionId: "dim_form", optionIds: ["opt_graded"] }],
            allowedOptions: [{ optionId: "opt_gem_mint", code: "gem-mint", label: "Gem Mint" }],
          },
          {
            dimensionId: "dim_condition",
            dimensionName: "Condition",
            required: true,
            appliesWhen: [{ dimensionId: "dim_form", optionIds: ["opt_raw"] }],
            allowedOptions: [
              { optionId: "opt_near_mint", code: "near-mint", label: "Near Mint" },
              { optionId: "opt_played", code: "played", label: "Played" },
            ],
          },
        ],
      }),
    ).toEqual([
      { dimensionId: "dim_form", optionId: "opt_raw" },
      { dimensionId: "dim_condition", optionId: "opt_near_mint" },
    ]);
  });

  it("reconciles selected current Catalog candidates into Inventory and Marketplace catalog projections", async () => {
    const inventoryQueries: QueryCall[] = [];
    const marketplaceQueries: QueryCall[] = [];
    const inventoryDb = queryRecorder(inventoryQueries);
    const marketplaceDb = queryRecorder(marketplaceQueries);
    const candidate = representativeCatalogCandidate("cat_real_1");

    await expect(reconcileRepresentativeInventoryCatalogItems({ db: inventoryDb }, [candidate])).resolves.toBe(1);
    await expect(reconcileRepresentativeMarketplaceCatalogItems(marketplaceDb, [candidate])).resolves.toBe(1);

    expect(String(inventoryQueries[0]?.[0])).toContain("INSERT INTO inventory_catalog_items");
    expect(inventoryQueries[0]?.[1]).toEqual([
      "cat_real_1",
      "en",
      "Real Imported Card",
      "Provider expansion 12/123",
      "bp_card",
      "active",
      JSON.stringify({ canonicalDimensionOrder: [], dimensions: [] }),
      "2026-05-27T00:00:00.000Z",
    ]);
    expect(String(marketplaceQueries[0]?.[0])).toContain("INSERT INTO marketplace_catalog_items");
    expect(marketplaceQueries[0]?.[1]).toContain(JSON.stringify([{ productId: "cat_real_1::" }]));
  });

  it("loads and filters active Marketplace catalog items that do not already have listings or offers", async () => {
    const loadQueries: QueryCall[] = [];
    const rows = [
      {
        catalog_item_id: "cat_real_1",
        title: "Real Imported Card",
        subtitle: "Provider expansion 12/123",
        blueprint_id: "bp_card",
        updated_at: "2026-05-27T00:00:00.000Z",
      },
    ];
    const loadDb: RepresentativeQueryable = {
      query: async <Row>(sql: string, params?: readonly unknown[]) => {
        loadQueries.push([sql, params]);
        return { rows: rows as Row[] };
      },
    };

    await expect(loadUntouchedMarketplaceCatalogUsageCandidates(loadDb, { limit: 25 })).resolves.toEqual([
      {
        catalogItemId: "cat_real_1",
        title: "Real Imported Card",
        subtitle: "Provider expansion 12/123",
        blueprintId: "bp_card",
        updatedAt: "2026-05-27T00:00:00.000Z",
      },
    ]);
    expect(String(loadQueries[0]?.[0])).toContain("jsonb_array_length(item.product_measure_snapshots)");
    expect(String(loadQueries[0]?.[0])).toContain("LEFT JOIN marketplace_listing_pages listing");
    expect(String(loadQueries[0]?.[0])).toContain("LEFT JOIN marketplace_offer_pages offer");
    expect(loadQueries[0]?.[1]).toEqual([25]);

    const filterQueries: QueryCall[] = [];
    const filterDb: RepresentativeQueryable = {
      query: async <Row>(sql: string, params?: readonly unknown[]) => {
        filterQueries.push([sql, params]);
        return { rows: [{ catalog_item_id: "cat_touched_1" }] as Row[] };
      },
    };
    const candidates = [
      representativeCatalogCandidate("cat_touched_1"),
      representativeCatalogCandidate("cat_untouched_1"),
      representativeCatalogCandidate("cat_untouched_2"),
    ];

    await expect(filterUntouchedMarketplaceCatalogUsageCandidates(filterDb, candidates, { limit: 1 })).resolves.toEqual(
      [representativeCatalogCandidate("cat_untouched_1")],
    );
    expect(String(filterQueries[0]?.[0])).toContain("FROM marketplace_listing_pages listing");
    expect(String(filterQueries[0]?.[0])).toContain("FROM marketplace_offer_pages offer");
    expect(filterQueries[0]?.[1]).toEqual([["cat_touched_1", "cat_untouched_1", "cat_untouched_2"]]);
  });

  it("keeps required Product Contents candidates ahead of and outside the untouched-item budget", async () => {
    const container = representativeCatalogCandidate("cat_product_contents_container");
    const contained = representativeCatalogCandidate("cat_product_contents_contained");
    const plannedCandidates = prioritizeRepresentativeCatalogUsageCandidates(
      [container, contained],
      [representativeCatalogCandidate("cat_current_1"), container, representativeCatalogCandidate("cat_current_2")],
    );
    const db: RepresentativeQueryable = {
      query: async <Row>() => ({
        rows: [{ catalog_item_id: container.catalogItemId }, { catalog_item_id: contained.catalogItemId }] as Row[],
      }),
    };

    await expect(
      filterUntouchedMarketplaceCatalogUsageCandidates(db, plannedCandidates, {
        limit: 1,
        priorityCatalogItemIds: [container.catalogItemId, contained.catalogItemId],
      }),
    ).resolves.toEqual([container, contained, representativeCatalogCandidate("cat_current_1")]);
  });

  it("submits and accepts representative offers with stable current-state inputs", async () => {
    const submitted: unknown[] = [];
    const submitServices = {
      db: {
        query: async <Row>(sql: string) => {
          if (sql.includes("FROM marketplace_offer_pages")) {
            return { rows: [] as Row[] };
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

    const offers = await submitRepresentativeOffers(submitServices as never, [representativeStock()]);

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

    const accepted: unknown[] = [];
    const acceptServices = {
      db: {
        query: async <Row>() => ({ rows: [{ status: "submitted" }] as Row[] }),
      },
      offers: {
        previewOfferAcceptanceTerms: async () => ({ fee_quote_fingerprint: "fee_1" }),
        acceptOffer: async (params: unknown) => {
          accepted.push(params);
          return { offerId: (params as { offerId: string }).offerId, version: 2 };
        },
      },
    };

    await expect(acceptRepresentativeOffers(acceptServices as never, [representativeStock()])).resolves.toEqual([
      expect.objectContaining({
        catalogItemId: "cat_real_1",
        sellerAccountId: "acc_repr_card_vault_account",
        status: "accepted",
      }),
    ]);
    expect(accepted).toEqual([
      expect.objectContaining({
        sellerAccountId: "acc_repr_card_vault_account",
        listingId: expect.stringMatching(/^lst_repr_/),
        feeQuoteFingerprint: "fee_1",
      }),
    ]);
  });

  it("reconciles selected representative marketplace facts into Discovery without replaying the full projection", async () => {
    const discoveryQueries: QueryCall[] = [];
    const discoveryDb = queryRecorder(discoveryQueries);
    const marketplaceQueries: QueryCall[] = [];
    const marketplaceDb: RepresentativeQueryable = {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        marketplaceQueries.push([sql, values]);
        if (sql.includes("FROM marketplace_listing_pages")) {
          return { rows: [marketplaceListing()] as Row[] };
        }
        if (sql.includes("FROM marketplace_offer_pages")) {
          return { rows: [marketplaceOffer()] as Row[] };
        }
        if (sql.includes("FROM marketplace_account_pages")) {
          return {
            rows: [
              marketplaceAccount("acc_seller", "Representative Seller"),
              marketplaceAccount("acc_buyer", "Representative Buyer"),
            ] as Row[],
          };
        }
        return { rows: [] as Row[] };
      },
    };

    const result = await reconcileRepresentativeDiscoveryMarketState(
      { discoveryDb, marketplaceDb },
      { listingIds: ["lst_repr_1", "lst_repr_1"], offerIds: ["off_repr_1"] },
    );

    expect(result).toEqual({ accountCount: 2, listingCount: 1, offerCount: 1 });
    expect(marketplaceQueries[0]?.[1]).toEqual([["lst_repr_1"]]);
    expect(marketplaceQueries[1]?.[1]).toEqual([["off_repr_1"]]);
    expect(discoveryQueries.some(([sql]) => sql.includes("INSERT INTO discovery_market_accounts"))).toBe(true);
    expect(discoveryQueries.some(([sql]) => sql.includes("INSERT INTO discovery_market_listings"))).toBe(true);
    expect(discoveryQueries.some(([sql]) => sql.includes("INSERT INTO discovery_offer_demand_matches"))).toBe(true);
  });

  it("reconciles selected representative marketplace and inventory facts into Ordering supply inputs", async () => {
    const orderingQueries: QueryCall[] = [];
    const orderingDb = queryRecorder(orderingQueries);
    const marketplaceQueries: QueryCall[] = [];
    const marketplaceDb: RepresentativeQueryable = {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        marketplaceQueries.push([sql, values]);
        if (sql.includes("FROM marketplace_listing_pages")) {
          return { rows: [marketplaceListing()] as Row[] };
        }
        return { rows: [] as Row[] };
      },
    };
    const inventoryQueries: QueryCall[] = [];
    const inventoryDb: RepresentativeQueryable = {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        inventoryQueries.push([sql, values]);
        if (sql.includes("FROM inventory_items")) {
          return { rows: [inventoryItem()] as Row[] };
        }
        if (sql.includes("FROM inventory_holds")) {
          return { rows: [inventoryHold()] as Row[] };
        }
        return { rows: [] as Row[] };
      },
    };

    const result = await reconcileRepresentativeOrderingSupplyState(
      { inventoryDb, marketplaceDb, orderingDb },
      { listingIds: ["lst_repr_1", "lst_repr_1"] },
    );

    expect(result).toEqual({ listingCount: 1, inventoryItemCount: 1, inventoryHoldCount: 1 });
    expect(marketplaceQueries[0]?.[1]).toEqual([["lst_repr_1"]]);
    expect(inventoryQueries[0]?.[1]).toEqual([["inv_1"]]);
    expect(inventoryQueries[1]?.[1]).toEqual([["inv_1"]]);

    const listingInsert = orderingQueries.find(([sql]) => sql.includes("INSERT INTO ordering_market_listing_inputs"));
    expect(listingInsert?.[1]).toEqual([
      "lst_repr_1",
      "acc_seller",
      "inv_1",
      "cat_1",
      "prd_1",
      "2026 Test Card",
      "Parallel",
      JSON.stringify([{ dimensionId: "condition", optionId: "raw" }]),
      "Condition: Raw",
      JSON.stringify({ productId: "prd_1" }),
      "Listing stock",
      "US-IL",
      JSON.stringify({ countryCode: "US", regionCode: "IL" }),
      "9.99",
      "1.23",
      "8.76",
      500,
      "terms_schedule_1",
      "terms_agreement_1",
      "2026-05-27T00:01:00.000Z",
      2,
      1,
      null,
      1,
      "available",
      "active",
      "2026-05-27T00:00:00.000Z",
    ]);
    expect(
      orderingQueries.some(([sql]) => sql.includes("INSERT INTO ordering_seller_listing_availability_inputs")),
    ).toBe(true);
    expect(orderingQueries.some(([sql]) => sql.includes("INSERT INTO ordering_inventory_item_inputs"))).toBe(true);
    expect(orderingQueries.some(([sql]) => sql.includes("DELETE FROM ordering_inventory_hold_inputs"))).toBe(true);
    expect(orderingQueries.some(([sql]) => sql.includes("INSERT INTO ordering_inventory_hold_inputs"))).toBe(true);
  });

  it("repairs existing representative Ordering supply inputs when no untouched listing candidates remain", async () => {
    const orderingQueries: QueryCall[] = [];
    const marketplaceQueries: QueryCall[] = [];
    const inventoryQueries: QueryCall[] = [];
    const marketplaceDb: RepresentativeQueryable = {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        marketplaceQueries.push([sql, values]);
        if (sql.includes("WHERE listing.listing_id LIKE")) {
          return { rows: [{ listing_id: "lst_repr_existing" }] as Row[] };
        }
        if (sql.includes("FROM marketplace_listing_pages")) {
          return { rows: [marketplaceListing()] as Row[] };
        }
        return { rows: [] as Row[] };
      },
    };
    const inventoryDb: RepresentativeQueryable = {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        inventoryQueries.push([sql, values]);
        if (sql.includes("FROM inventory_items")) {
          return { rows: [inventoryItem()] as Row[] };
        }
        return { rows: [] as Row[] };
      },
    };

    const result = await reconcileRepresentativeOrderingSupplyState(
      { inventoryDb, marketplaceDb, orderingDb: queryRecorder(orderingQueries) },
      { listingIds: [], existingRepresentativeLimit: 25 },
    );

    expect(result).toEqual({ listingCount: 1, inventoryItemCount: 1, inventoryHoldCount: 0 });
    expect(String(marketplaceQueries[0]?.[0])).toContain("listing.listing_id LIKE 'lst$_repr$_%' ESCAPE '$'");
    expect(marketplaceQueries[0]?.[1]).toEqual([25]);
    expect(marketplaceQueries[1]?.[1]).toEqual([["lst_repr_existing"]]);
    expect(inventoryQueries[0]?.[1]).toEqual([["inv_1"]]);
    expect(orderingQueries.some(([sql]) => sql.includes("INSERT INTO ordering_market_listing_inputs"))).toBe(true);
  });

  it("repairs existing representative marketplace facts when no untouched catalog candidates remain", async () => {
    const discoveryQueries: QueryCall[] = [];
    const discoveryDb = queryRecorder(discoveryQueries);
    const marketplaceQueries: QueryCall[] = [];
    const marketplaceDb: RepresentativeQueryable = {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        marketplaceQueries.push([sql, values]);
        if (sql.includes("WHERE listing.listing_id LIKE")) {
          return { rows: [{ listing_id: "lst_repr_existing" }] as Row[] };
        }
        if (sql.includes("WHERE offer.offer_id LIKE")) {
          return { rows: [{ offer_id: "off_repr_existing" }] as Row[] };
        }
        if (sql.includes("FROM marketplace_listing_pages")) {
          return { rows: [marketplaceListing()] as Row[] };
        }
        if (sql.includes("FROM marketplace_offer_pages")) {
          return { rows: [marketplaceOffer()] as Row[] };
        }
        if (sql.includes("FROM marketplace_account_pages")) {
          return {
            rows: [
              marketplaceAccount("acc_seller", "Representative Seller"),
              marketplaceAccount("acc_buyer", "Representative Buyer"),
            ] as Row[],
          };
        }
        return { rows: [] as Row[] };
      },
    };

    const result = await reconcileRepresentativeDiscoveryMarketState(
      { discoveryDb, marketplaceDb },
      { listingIds: [], offerIds: [], existingRepresentativeLimit: 25 },
    );

    expect(result).toEqual({ accountCount: 2, listingCount: 1, offerCount: 1 });
    expect(String(marketplaceQueries[0]?.[0])).toContain("listing.listing_id LIKE 'lst$_repr$_%' ESCAPE '$'");
    expect(marketplaceQueries[0]?.[1]).toEqual([25]);
    expect(String(marketplaceQueries[1]?.[0])).toContain("offer.offer_id LIKE 'off$_repr$_%' ESCAPE '$'");
    expect(marketplaceQueries[1]?.[1]).toEqual([25]);
    expect(marketplaceQueries[2]?.[1]).toEqual([["lst_repr_existing"]]);
    expect(marketplaceQueries[3]?.[1]).toEqual([["off_repr_existing"]]);
    expect(discoveryQueries.some(([sql]) => sql.includes("INSERT INTO discovery_market_listings"))).toBe(true);
  });
});

function queryRecorder(queries: QueryCall[]): RepresentativeQueryable {
  return {
    query: async <Row>(sql: string, params?: readonly unknown[]) => {
      queries.push([sql, params]);
      return { rows: [] as Row[], rowCount: 1 };
    },
  };
}

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

function representativeStock() {
  return {
    catalogItemId: "cat_real_1",
    accountId: "acc_repr_card_vault_account",
    inventoryItemId: "inv_repr_1",
    selectedOptions: [],
    totalQuantity: 4,
  };
}

function marketplaceListing() {
  return {
    listing_id: "lst_repr_1",
    account_id: "acc_seller",
    inventory_item_id: "inv_1",
    catalog_catalog_item_id: "cat_1",
    product_id: "prd_1",
    item_title: "2026 Test Card",
    item_subtitle: "Parallel",
    selected_options: [{ dimensionId: "condition", optionId: "raw" }],
    product_summary: "Condition: Raw",
    product_measure_snapshot: { productId: "prd_1" },
    storage_location_name: "Listing stock",
    ship_from_code: "US-IL",
    ship_from_address: { countryCode: "US", regionCode: "IL" },
    price_amount: "9.99",
    marketplace_sales_fee_unit_amount: "1.23",
    seller_net_unit_amount: "8.76",
    shipping_allowance_percentage_bps: 500,
    terms_schedule_id: "terms_schedule_1",
    terms_agreement_id: "terms_agreement_1",
    terms_resolved_at: "2026-05-27T00:01:00.000Z",
    quantity_cap: 2,
    max_units_per_order: 1,
    max_units_per_day: null,
    max_units_per_customer_account: 1,
    seller_listing_availability_status: "available",
    seller_listing_availability_updated_at: "2026-05-27T00:02:00.000Z",
    supply_total_quantity: 4,
    active_held_quantity: 0,
    status: "active",
    created_at: "2026-05-27T00:00:00.000Z",
    updated_at: "2026-05-27T00:00:00.000Z",
  };
}

function inventoryItem() {
  return {
    item_id: "inv_1",
    account_id: "acc_seller",
    catalog_catalog_item_id: "cat_1",
    product_id: "prd_1",
    total_quantity: 4,
    updated_at: "2026-05-27T00:03:00.000Z",
    last_stream_version: "7",
  };
}

function inventoryHold() {
  return {
    hold_id: "hold_repr_1",
    account_id: "acc_seller",
    item_id: "inv_1",
    quantity: 1,
    status: "active",
    released_at: null,
    updated_at: "2026-05-27T00:04:00.000Z",
    last_stream_version: "8",
  };
}

function marketplaceOffer() {
  return {
    offer_id: "off_repr_1",
    buyer_account_id: "acc_buyer",
    catalog_catalog_item_id: "cat_1",
    product_id: "prd_1",
    item_title: "2026 Test Card",
    item_subtitle: "Parallel",
    selected_options: [{ dimensionId: "condition", optionId: "raw" }],
    product_summary: "Condition: Raw",
    price_amount: "7.75",
    quantity_requested: 1,
    status: "accepted",
    accepted_seller_account_id: "acc_seller",
    accepted_at: "2026-05-27T00:05:00.000Z",
    created_at: "2026-05-27T00:00:00.000Z",
    updated_at: "2026-05-27T00:05:00.000Z",
  };
}

function marketplaceAccount(accountId: string, displayName: string) {
  return {
    account_id: accountId,
    display_name: displayName,
    status: "active",
    average_rating: "4.80",
    review_count: 5,
    rating_1_count: 0,
    rating_2_count: 0,
    rating_3_count: 0,
    rating_4_count: 1,
    rating_5_count: 4,
    reputation_updated_at: "2026-05-27T00:00:00.000Z",
    seller_listing_availability_status: "available",
    seller_listing_availability_reason_category: null,
    seller_listing_available_again_on: null,
    updated_at: "2026-05-27T00:00:00.000Z",
  };
}
