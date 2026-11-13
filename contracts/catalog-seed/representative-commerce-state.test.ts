import { describe, expect, it } from "vitest";
import {
  acceptRepresentativeOffers,
  ensureRepresentativeInventoryStock,
  loadRepresentativeCatalogUsageCandidates,
  normalizeRepresentativeCandidateLimit,
  normalizeRepresentativeCatalogCandidateLimit,
  observeRepresentativeDiscoveryMarketState,
  prepareRepresentativeCatalogUsageCandidates,
  prepareRepresentativeCatalogUsageCandidatesByIds,
  prioritizeRepresentativeCatalogUsageCandidates,
  publishRepresentativeListings,
  reconcileRepresentativeInventoryCatalogItems,
  reconcileRepresentativeMarketplaceCatalogItems,
  reconcileRepresentativeOrderingSupplyState,
  selectDefaultRepresentativeOptions,
  selectRepresentativeCatalogUsageCandidates,
  submitRepresentativeOffers,
  type CatalogRepresentativeCatalogUsageCandidate,
  type RepresentativeMarketplaceServices,
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

  it("selects the ordered representative candidate set independently of marketplace usage state", () => {
    const candidates = [
      representativeCatalogCandidate("cat_current_1"),
      representativeCatalogCandidate("cat_current_2"),
      representativeCatalogCandidate("cat_current_3"),
    ];

    expect(selectRepresentativeCatalogUsageCandidates(candidates, { limit: 2 })).toEqual([
      representativeCatalogCandidate("cat_current_1"),
      representativeCatalogCandidate("cat_current_2"),
    ]);
    // The same input set selects the same cohort on a retained repeat run.
    expect(selectRepresentativeCatalogUsageCandidates(candidates, { limit: 2 })).toEqual(
      selectRepresentativeCatalogUsageCandidates(candidates, { limit: 2 }),
    );
  });

  it("keeps required Product Contents candidates ahead of and outside the candidate budget", () => {
    const container = representativeCatalogCandidate("cat_product_contents_container");
    const contained = representativeCatalogCandidate("cat_product_contents_contained");
    const plannedCandidates = prioritizeRepresentativeCatalogUsageCandidates(
      [container, contained],
      [representativeCatalogCandidate("cat_current_1"), container, representativeCatalogCandidate("cat_current_2")],
    );

    expect(
      selectRepresentativeCatalogUsageCandidates(plannedCandidates, {
        limit: 1,
        priorityCatalogItemIds: [container.catalogItemId, contained.catalogItemId],
      }),
    ).toEqual([container, contained, representativeCatalogCandidate("cat_current_1")]);
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
        priceCurrencyCode: "USD",
        quantityRequested: 1,
      }),
    ]);

    const accepted: unknown[] = [];
    const acceptServices = {
      db: offerStatusDb(["submitted"]),
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

  it("observes derived Discovery representative state without writing projection rows", async () => {
    const queries: QueryCall[] = [];
    const discoveryDb: RepresentativeQueryable = {
      query: async <Row>(sql: string, params?: readonly unknown[]) => {
        queries.push([sql, params]);
        return { rows: [{ account_count: 2, listing_count: 1, offer_count: 1 }] as Row[] };
      },
    };

    const result = await observeRepresentativeDiscoveryMarketState(
      { discoveryDb },
      { listingIds: ["lst_repr_1"], offerIds: ["off_repr_1"] },
    );

    expect(result).toEqual({ accountCount: 2, listingCount: 1, offerCount: 1 });
    expect(queries).toHaveLength(1);
    expect(queries.every(([sql]) => /^\s*SELECT\b/.test(sql))).toBe(true);
    expect(queries.every(([sql]) => !/\b(?:INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(true);
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
});

describe("representative offer submission limits", () => {
  it("bounds new submissions to five per buyer for a cohort larger than the daily cap", async () => {
    const harness = submissionHarness();
    const stock = representativeStockItems(60);

    const results = await submitRepresentativeOffers(harness.services as never, stock);

    expect(harness.submitted).toHaveLength(10);
    for (const buyerAccountId of new Set(harness.submitted.map((offer) => offer.buyerAccountId))) {
      expect(harness.submitted.filter((offer) => offer.buyerAccountId === buyerAccountId)).toHaveLength(5);
    }
    expect(results).toHaveLength(60);
    expect(results.filter((offer) => offer.status === "created")).toHaveLength(10);
    expect(results.filter((offer) => offer.status === "skipped")).toHaveLength(50);
    expect(results[59]).toMatchObject({
      catalogItemId: stock[59].catalogItemId,
      status: "skipped",
      reason: "representative_offer_submission_limit_reached",
    });

    const accepted: unknown[] = [];
    const acceptance = acceptanceServices(
      results.map((offer) => (offer.status === "created" ? "submitted" : null)),
      accepted,
    );
    const acceptanceResults = await acceptRepresentativeOffers(acceptance as never, stock, { maxAcceptedOffers: 10 });
    expect(accepted).toHaveLength(10);
    expect(acceptanceResults.filter((offer) => offer.status === "skipped")).toHaveLength(50);
  });

  it("counts all retained cohort Offers toward each buyer's budget, including later items", async () => {
    const existingCatalogItemIds = ["cat_synthetic_1", "cat_synthetic_2", "cat_synthetic_15", "cat_synthetic_16"];
    const harness = submissionHarness({ existingOfferIndexes: [0, 1, 14, 15] });

    const results = await submitRepresentativeOffers(
      harness.services as never,
      representativeStockItems(16, "cat_synthetic"),
    );

    expect(harness.submitted).toHaveLength(6);
    expect(results.filter((offer) => offer.status === "already-present").map((offer) => offer.catalogItemId)).toEqual(
      existingCatalogItemIds,
    );
    expect(results.filter((offer) => offer.status === "skipped")).toHaveLength(6);
    for (const buyerAccountId of new Set(results.map((offer) => offer.buyerAccountId))) {
      expect(
        results.filter((offer) => offer.buyerAccountId === buyerAccountId && offer.status !== "skipped"),
      ).toHaveLength(5);
    }
  });

  it("submits no new Offers for a 60-item cohort with five retained Offers per buyer", async () => {
    const harness = submissionHarness({ existingOfferIndexes: Array.from({ length: 10 }, (_, index) => index + 50) });

    const results = await submitRepresentativeOffers(
      harness.services as never,
      representativeStockItems(60, "cat_synthetic"),
    );

    expect(harness.submitted).toHaveLength(0);
    expect(results.filter((offer) => offer.status === "already-present")).toHaveLength(10);
    expect(results.filter((offer) => offer.status === "skipped")).toHaveLength(50);
  });

  it("leaves sampled Offers unchanged on a repeat run against retained state", async () => {
    const harness = submissionHarness();
    const stock = representativeStockItems(60, "cat_synthetic");
    const initial = await submitRepresentativeOffers(harness.services as never, stock);
    const repeat = await submitRepresentativeOffers(harness.services as never, stock);

    expect(harness.submitted).toHaveLength(10);
    expect(repeat).toEqual(
      initial.map((offer) => (offer.status === "created" ? { ...offer, status: "already-present" } : offer)),
    );
  });

  it("records a daily cap refusal as skipped and continues submission and acceptance for other items", async () => {
    const capError = Object.assign(new Error("Daily offer limit reached."), {
      name: "MarketplaceOfferAbuseControlError",
      code: "offer_daily_submission_cap_reached",
    });
    const harness = submissionHarness({
      submissionError: (offer) => (offer.catalogItemId === "cat_real_1" ? capError : null),
    });
    const stock = representativeStockItems(3);

    const results = await submitRepresentativeOffers(harness.services as never, stock);

    expect(results[0]).toMatchObject({
      catalogItemId: "cat_real_1",
      offerId: expect.stringMatching(/^off_repr_/),
      status: "skipped",
      reason: "offer_daily_submission_cap_reached",
    });
    expect(results.slice(1).map((offer) => offer.status)).toEqual(["created", "created"]);
    const accepted: unknown[] = [];
    const acceptance = acceptanceServices([null, "submitted", "submitted"], accepted);
    const acceptanceResults = await acceptRepresentativeOffers(acceptance as never, stock);
    expect(accepted).toHaveLength(2);
    expect(acceptanceResults.map((offer) => offer.status)).toEqual(["skipped", "accepted", "accepted"]);
  });

  it("bounds attempts even when every submission is refused by the daily cap", async () => {
    const harness = submissionHarness({
      submissionError: () =>
        Object.assign(new Error("Daily offer limit reached."), {
          name: "MarketplaceOfferAbuseControlError",
          code: "offer_daily_submission_cap_reached",
        }),
    });

    const results = await submitRepresentativeOffers(harness.services as never, representativeStockItems(60));

    expect(harness.submitted).toHaveLength(10);
    expect(results.every((offer) => offer.status === "skipped")).toBe(true);
  });

  it.each([
    new Error("Submission failed."),
    Object.assign(new Error("Different abuse control."), { name: "MarketplaceOfferAbuseControlError", code: "other" }),
    Object.assign(new Error("Unrelated error."), { code: "offer_daily_submission_cap_reached" }),
    { name: "MarketplaceOfferAbuseControlError", code: "offer_daily_submission_cap_reached" },
  ])("rethrows other submission errors unchanged: %s", async (error) => {
    const harness = submissionHarness({ submissionError: () => error });

    await expect(submitRepresentativeOffers(harness.services as never, representativeStockItems(1))).rejects.toBe(
      error,
    );
  });
});

describe("representative offer acceptance retained-state idempotency", () => {
  it("recognizes retained accepted offers instead of accepting more on a repeat run", async () => {
    const accepted: unknown[] = [];
    const services = acceptanceServices(["accepted", "accepted", "submitted", "submitted"], accepted);

    const results = await acceptRepresentativeOffers(services as never, representativeStockItems(4));

    expect(accepted).toEqual([]);
    expect(results).toEqual([
      expect.objectContaining({ status: "already-accepted" }),
      expect.objectContaining({ status: "already-accepted" }),
      expect.objectContaining({
        status: "skipped",
        reason: "Retained accepted-offer limit is already satisfied.",
      }),
      expect.objectContaining({
        status: "skipped",
        reason: "Retained accepted-offer limit is already satisfied.",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "accepted" || result.status === "already-accepted"),
    ).toHaveLength(2);
  });

  it("resumes a partially accepted run by accepting only up to the retained limit", async () => {
    const accepted: unknown[] = [];
    const services = acceptanceServices(["accepted", "submitted", "submitted"], accepted);

    const results = await acceptRepresentativeOffers(services as never, representativeStockItems(3));

    expect(accepted).toHaveLength(1);
    expect(results).toEqual([
      expect.objectContaining({ status: "already-accepted" }),
      expect.objectContaining({ status: "accepted" }),
      expect.objectContaining({
        status: "skipped",
        reason: "Retained accepted-offer limit is already satisfied.",
      }),
    ]);
  });

  it("does not overshoot when retained acceptances already satisfy the limit", async () => {
    const accepted: unknown[] = [];
    const services = acceptanceServices(["submitted", "accepted", "accepted"], accepted);

    const results = await acceptRepresentativeOffers(services as never, representativeStockItems(3));

    expect(accepted).toEqual([]);
    expect(results).toEqual([
      expect.objectContaining({
        status: "skipped",
        reason: "Retained accepted-offer limit is already satisfied.",
      }),
      expect.objectContaining({ status: "already-accepted" }),
      expect.objectContaining({ status: "already-accepted" }),
    ]);
  });

  it("rejects three retained accepted offers within the planned cohort", async () => {
    const accepted: unknown[] = [];
    const services = acceptanceServices(["accepted", "accepted", "accepted"], accepted);

    await expect(acceptRepresentativeOffers(services as never, representativeStockItems(3))).rejects.toThrow(
      "Invalid retained representative accepted-offer state: 3 accepted offers exceed the retained limit of 2.",
    );
    expect(accepted).toEqual([]);
  });

  it("rejects a retained accepted representative offer outside the current planned cohort", async () => {
    const accepted: unknown[] = [];
    const services = acceptanceServices(["submitted", "submitted"], accepted, ["off_repr_prior_untouched_cohort"]);

    await expect(acceptRepresentativeOffers(services as never, representativeStockItems(2))).rejects.toThrow(
      "Invalid retained representative accepted-offer state: accepted offer ids are outside the current planned cohort: off_repr_prior_untouched_cohort.",
    );
    expect(accepted).toEqual([]);
  });

  it("keeps first-run acceptance bounded to the accepted-offer limit", async () => {
    const accepted: unknown[] = [];
    const services = acceptanceServices(["submitted", "submitted", "submitted", "submitted"], accepted);

    const results = await acceptRepresentativeOffers(services as never, representativeStockItems(4));

    expect(accepted).toHaveLength(2);
    expect(results).toEqual([
      expect.objectContaining({ status: "accepted" }),
      expect.objectContaining({ status: "accepted" }),
      expect.objectContaining({
        status: "skipped",
        reason: "Retained accepted-offer limit is already satisfied.",
      }),
      expect.objectContaining({
        status: "skipped",
        reason: "Retained accepted-offer limit is already satisfied.",
      }),
    ]);
  });
});

describe("representative inventory stock retained-state reuse", () => {
  it("reuses retained listing stock without re-ensuring through the domain", async () => {
    const harness = inventoryStockHarness({
      retainedRow: {
        item_id: "inv_listing_stock_retained",
        storage_location_id: "loc_repr_default",
        selected_options: [{ dimensionId: "dim_form", optionId: "opt_raw" }],
        total_quantity: 4,
      },
    });

    const results = await ensureRepresentativeInventoryStock(harness.services as never, [
      { catalogItemId: "cat_real_1" },
    ]);

    expect(harness.ensured).toEqual([]);
    expect(results).toEqual([
      {
        catalogItemId: "cat_real_1",
        accountId: "acc_repr_card_vault_account",
        inventoryItemId: "inv_listing_stock_retained",
        storageLocationId: "loc_repr_default",
        selectedOptions: [{ dimensionId: "dim_form", optionId: "opt_raw" }],
        totalQuantity: 4,
        createdInventoryItem: false,
        adjustedQuantityBy: 0,
      },
    ]);
    expect(String(harness.queries[0]?.[0])).toContain("FROM inventory_items");
    expect(String(harness.queries[0]?.[0])).toContain("item_id LIKE 'inv$_listing$_stock$_%' ESCAPE '$'");
    expect(harness.queries[0]?.[1]).toEqual(["acc_repr_card_vault_account", "cat_real_1", "cat_real_1::"]);
  });

  it("ensures stock through the domain when no retained listing stock exists", async () => {
    const harness = inventoryStockHarness({ retainedRow: null });

    const results = await ensureRepresentativeInventoryStock(harness.services as never, [
      { catalogItemId: "cat_real_1" },
    ]);

    expect(harness.ensured).toHaveLength(1);
    expect(results).toEqual([expect.objectContaining({ inventoryItemId: "inv_new", createdInventoryItem: true })]);
  });

  it("tops up through the domain when retained stock is below the target quantity", async () => {
    const harness = inventoryStockHarness({
      retainedRow: {
        item_id: "inv_listing_stock_retained",
        storage_location_id: "loc_repr_default",
        selected_options: [],
        total_quantity: 2,
      },
    });

    await ensureRepresentativeInventoryStock(harness.services as never, [{ catalogItemId: "cat_real_1" }]);

    expect(harness.ensured).toHaveLength(1);
    expect(harness.ensured[0]).toMatchObject({
      accountId: "acc_repr_card_vault_account",
      catalogItemId: "cat_real_1",
      quantity: 4,
    });
  });
});

describe("representative listing publication restart safety", () => {
  it("creates and publishes with photo evidence on a first run", async () => {
    const harness = listingHarness(null);

    const results = await publishRepresentativeListings(harness.services as never, [representativeStock()]);

    expect(harness.created).toEqual([
      expect.objectContaining({
        priceAmount: "9.99",
        priceCurrencyCode: "USD",
        quantityCap: 2,
        listingPhotoUploads: [expect.objectContaining({ contentType: "image/png" })],
      }),
    ]);
    expect(harness.updated).toEqual([]);
    expect(harness.published).toHaveLength(1);
    expect(results).toEqual([expect.objectContaining({ status: "created" })]);
  });

  it("publishes a retained draft from its own fee quote at its decided version without re-creating it", async () => {
    const harness = listingHarness("draft");

    const results = await publishRepresentativeListings(harness.services as never, [representativeStock()]);

    expect(harness.created).toEqual([]);
    expect(harness.updated).toEqual([]);
    expect(harness.published).toEqual([
      expect.objectContaining({ feeQuoteFingerprint: "fee_retained", expectedVersion: 2 }),
    ]);
    expect(results).toEqual([expect.objectContaining({ status: "already-present" })]);
  });

  it("repairs an amount-only retained canary through the keyed seller Listing command at its decided version", async () => {
    const harness = listingHarness({
      status: "active",
      price_amount: "9.99",
      price_currency_code: null,
      listing_stream_version: 2,
    });

    const results = await publishRepresentativeListings(harness.services as never, [representativeStock()]);

    expect(harness.created).toEqual([]);
    expect(harness.published).toEqual([]);
    expect(harness.updated).toEqual([
      expect.objectContaining({
        accountId: "acc_repr_card_vault_account",
        priceAmount: "9.99",
        priceCurrencyCode: "USD",
        expectedVersion: 2,
        idempotencyKey: expect.stringMatching(/^repr_listing_price_[a-f0-9]{48}$/),
      }),
    ]);
    expect(results).toEqual([expect.objectContaining({ status: "price-repaired" })]);
    expect(harness.queries.every(([sql]) => /^\s*SELECT\b/.test(sql))).toBe(true);
  });

  it("heals a drained legacy canary projection at version 0 once, then never again", async () => {
    const store = listingStore({
      status: "active",
      price_amount: "9.99",
      price_currency_code: "USD",
      listing_stream_version: 0,
    });
    const first = listingHarness(null, store);

    await expect(publishRepresentativeListings(first.services as never, [representativeStock()])).resolves.toEqual([
      expect.objectContaining({ status: "price-repaired" }),
    ]);
    expect(first.updated).toEqual([expect.objectContaining({ priceCurrencyCode: "USD", expectedVersion: 0 })]);

    const repeat = listingHarness(null, store);
    await expect(publishRepresentativeListings(repeat.services as never, [representativeStock()])).resolves.toEqual([
      expect.objectContaining({ status: "already-present" }),
    ]);
    expect(repeat.writes()).toEqual([]);
  });

  it("resumes a crash after each append from the first receipt and writes nothing on repeat, reboot or day-after", async () => {
    for (const crashAfter of ["create", "publish"] as const) {
      const store = listingStore();
      const crashed = listingHarness(null, store);
      crashed.crashAfter(crashAfter);
      await expect(publishRepresentativeListings(crashed.services as never, [representativeStock()])).rejects.toThrow(
        `synthetic crash after ${crashAfter}`,
      );

      const resumed = listingHarness(null, store);
      await expect(
        publishRepresentativeListings(resumed.services as never, [representativeStock()]),
      ).resolves.toHaveLength(1);
      for (const boot of ["same-boot repeat", "second boot", "day-after"]) {
        const repeat = listingHarness(null, store);
        await expect(publishRepresentativeListings(repeat.services as never, [representativeStock()])).resolves.toEqual(
          [expect.objectContaining({ status: "already-present" })],
        );
        expect({ boot, writes: repeat.writes() }).toEqual({ boot, writes: [] });
      }
      expect(store.writes.map((write) => write.split(":")[0])).toEqual(["create@0", "publish@1"]);
    }
  });

  it("resumes a crash after the price-repair append without repairing twice", async () => {
    const store = listingStore([
      { status: "active", price_amount: "27.50", price_currency_code: "EUR", listing_stream_version: 7 },
    ]);
    const crashed = listingHarness(null, store);
    crashed.crashAfter("price");
    await expect(publishRepresentativeListings(crashed.services as never, [representativeStock()])).rejects.toThrow(
      "synthetic crash after price",
    );

    const resumed = listingHarness(null, store);
    await expect(publishRepresentativeListings(resumed.services as never, [representativeStock()])).resolves.toEqual([
      expect.objectContaining({ status: "already-present" }),
    ]);
    expect(store.writes.map((write) => write.split(":")[0])).toEqual(["price@7"]);
  });

  it("fails closed on an unusable Listing history and a stream that moved after the decision", async () => {
    const poisoned = listingHarness(null);
    poisoned.services.listings.readAuthoritativeListing = async () => {
      throw Object.assign(new Error("Listing history is unusable"), { code: "history_incomplete" });
    };
    await expect(publishRepresentativeListings(poisoned.services as never, [representativeStock()])).rejects.toThrow(
      "Listing history is unusable",
    );
    expect(poisoned.writes()).toEqual([]);

    const store = listingStore("draft");
    const raced = listingHarness(null, store);
    raced.interleaveBeforeWrite(() => store.foreignWrite());
    await expect(publishRepresentativeListings(raced.services as never, [representativeStock()])).rejects.toMatchObject(
      {
        code: "concurrency_conflict",
      },
    );
    expect(store.writes).toEqual(["foreign@2"]);
  });

  it("repairs a stale retained canary to its intended USD Listing Price", async () => {
    const harness = listingHarness({
      status: "active",
      price_amount: "27.50",
      price_currency_code: "EUR",
      listing_stream_version: 7,
    });

    await publishRepresentativeListings(harness.services as never, [representativeStock()]);

    expect(harness.updated).toEqual([expect.objectContaining({ priceAmount: "9.99", priceCurrencyCode: "USD" })]);
  });

  it("leaves an already-correct retained canary untouched on a repeat run", async () => {
    const harness = listingHarness({
      status: "active",
      price_amount: "9.99",
      price_currency_code: "USD",
      listing_stream_version: 2,
    });

    const results = await publishRepresentativeListings(harness.services as never, [representativeStock()]);

    expect(harness.created).toEqual([]);
    expect(harness.updated).toEqual([]);
    expect(harness.published).toEqual([]);
    expect(results).toEqual([expect.objectContaining({ status: "already-present" })]);
  });

  it("does not mutate unrelated retained representative Listings", async () => {
    const harness = listingHarness([
      { status: "active", price_amount: "9.99", price_currency_code: "USD", listing_stream_version: 2 },
      { status: "active", price_amount: "13.50", price_currency_code: null, listing_stream_version: 0 },
    ]);
    const unrelatedStock = {
      ...representativeStock(),
      catalogItemId: "cat_unrelated_legacy",
      inventoryItemId: "inv_unrelated_legacy",
    };

    await publishRepresentativeListings(harness.services as never, [representativeStock(), unrelatedStock]);

    expect(harness.updated).toEqual([]);
    expect(harness.created).toEqual([]);
    expect(harness.published).toEqual([]);
  });

  it("leaves retained non-draft non-canary lifecycle states untouched", async () => {
    for (const status of ["active", "paused", "withdrawn"]) {
      const harness = listingHarness([
        { status: "active", price_amount: "9.99", price_currency_code: "USD", listing_stream_version: 2 },
        { status, price_amount: "13.50", price_currency_code: "USD", listing_stream_version: 2 },
      ]);
      const secondStock = {
        ...representativeStock(),
        catalogItemId: "cat_real_2",
        inventoryItemId: "inv_repr_2",
      };

      const results = await publishRepresentativeListings(harness.services as never, [
        representativeStock(),
        secondStock,
      ]);

      expect(harness.created).toEqual([]);
      expect(harness.updated).toEqual([]);
      expect(harness.published).toEqual([]);
      expect(results).toHaveLength(2);
      expect(results.every((result) => result.status === "already-present")).toBe(true);
    }
  });
});

type RepresentativeOfferSubmission = Parameters<RepresentativeMarketplaceServices["offers"]["submitOffer"]>[0];

function submissionHarness(
  options: Readonly<{
    existingOfferIndexes?: readonly number[];
    submissionError?: (offer: RepresentativeOfferSubmission) => unknown;
  }> = {},
) {
  const submitted: RepresentativeOfferSubmission[] = [];
  const retainedOfferIds = new Set<string>();
  let offerQueryIndex = 0;
  const services = {
    db: {
      query: async <Row>(sql: string, params?: readonly unknown[]) => {
        if (sql.includes("FROM marketplace_offer_pages")) {
          const offerId = String(params?.[0]);
          if (options.existingOfferIndexes?.includes(offerQueryIndex++)) retainedOfferIds.add(offerId);
          return {
            rows: (retainedOfferIds.has(offerId) ? [{ status: "submitted" }] : []) as Row[],
          };
        }
        return {
          rows: [{ title: "Representative Card", subtitle: null, status: "active", product_schema: null }] as Row[],
        };
      },
    },
    offers: {
      submitOffer: async (offer: RepresentativeOfferSubmission) => {
        submitted.push(offer);
        const error = options.submissionError?.(offer);
        if (error) throw error;
        retainedOfferIds.add(offer.offerId!);
        return { offerId: offer.offerId!, version: 1 };
      },
    },
  };
  return { services, submitted };
}

function acceptanceServices(
  statusesByIndex: readonly (string | null)[],
  accepted: unknown[],
  retainedAcceptedOfferIds: readonly string[] = [],
) {
  return {
    db: offerStatusDb(statusesByIndex, retainedAcceptedOfferIds),
    offers: {
      previewOfferAcceptanceTerms: async () => ({ fee_quote_fingerprint: "fee_1" }),
      acceptOffer: async (params: unknown) => {
        accepted.push(params);
        return { offerId: (params as { offerId: string }).offerId, version: 2 };
      },
    },
  };
}

function offerStatusDb(
  statusesByIndex: readonly (string | null)[],
  retainedAcceptedOfferIds: readonly string[] = [],
): RepresentativeQueryable {
  return {
    query: async <Row>(sql: string, params?: readonly unknown[]) => {
      const offerIds = Array.isArray(params?.[0]) ? (params[0] as readonly string[]) : [];

      return {
        rows: [
          ...offerIds.flatMap((offerId, index) => {
            const status = statusesByIndex[index] ?? null;
            return status ? [{ offer_id: offerId, status }] : [];
          }),
          ...(sql.includes("offer_id LIKE 'off$_repr$_%'")
            ? retainedAcceptedOfferIds.map((offerId) => ({ offer_id: offerId, status: "accepted" }))
            : []),
        ] as Row[],
      };
    },
  };
}

function representativeStockItems(count: number, catalogItemPrefix = "cat_real") {
  return Array.from({ length: count }, (_, index) => ({
    catalogItemId: `${catalogItemPrefix}_${index + 1}`,
    accountId: index % 2 === 0 ? "acc_repr_card_vault_account" : "acc_repr_sealed_stockroom_account",
    inventoryItemId: `inv_repr_${index + 1}`,
    selectedOptions: [],
    totalQuantity: 4,
  }));
}

function inventoryStockHarness(
  options: Readonly<{
    retainedRow: Readonly<{
      item_id: string;
      storage_location_id: string;
      selected_options: unknown;
      total_quantity: number;
    }> | null;
  }>,
) {
  const ensured: unknown[] = [];
  const queries: QueryCall[] = [];

  return {
    ensured,
    queries,
    services: {
      db: {
        query: async <Row>(sql: string, params?: readonly unknown[]) => {
          queries.push([sql, params]);
          if (sql.includes("FROM inventory_items") && options.retainedRow) {
            return { rows: [options.retainedRow] as Row[] };
          }

          return { rows: [] as Row[] };
        },
      },
      catalogItems: {
        getCatalogItem: async () => ({ status: "active", product_schema: null }),
      },
      items: {
        ensureListingStock: async (params: unknown) => {
          ensured.push(params);
          return {
            inventoryItemId: "inv_new",
            storageLocationId: "loc_new",
            snapshot: { selectedOptions: [], totalQuantity: 4 },
            createdInventoryItem: true,
            adjustedQuantityBy: 0,
          };
        },
      },
    },
  };
}

type ListingHarnessRow = Readonly<{
  status: string;
  price_amount: string;
  price_currency_code: string | null;
  listing_stream_version: number | null;
}>;

type HarnessListing = Readonly<{
  version: number;
  status: string;
  priceAmount: string | null;
  priceCurrencyCode: string | null;
  feeQuoteFingerprint: string | null;
}>;

/**
 * Complete Listing streams keyed by Listing id. Retained rows are assigned in first-read order, and the store
 * honors the C1 contract the seed relies on: a recorded attempt replays its receipt with zero appends, and an
 * unrecorded one appends only at its `expectedVersion`.
 */
function listingStore(existing: string | ListingHarnessRow | readonly ListingHarnessRow[] | null = null) {
  const rows: readonly ListingHarnessRow[] = Array.isArray(existing)
    ? existing
    : existing
      ? [
          typeof existing === "string"
            ? { status: existing, price_amount: "9.99", price_currency_code: "USD", listing_stream_version: 2 }
            : (existing as ListingHarnessRow),
        ]
      : [];
  const listings = new Map<string, HarnessListing>();
  const assigned = new Set<string>();
  const receipts = new Map<string, number>();
  const writes: string[] = [];
  let nextRow = 0;

  return {
    writes,
    read(listingId: string): HarnessListing | null {
      if (!assigned.has(listingId)) {
        assigned.add(listingId);
        const row = rows[nextRow];
        nextRow += 1;
        if (row)
          listings.set(listingId, {
            version: row.listing_stream_version ?? 1,
            status: row.status,
            priceAmount: row.price_amount,
            priceCurrencyCode: row.price_currency_code,
            feeQuoteFingerprint: "fee_retained",
          });
      }
      return listings.get(listingId) ?? null;
    },
    apply(
      kind: "create" | "publish" | "price",
      listingId: string,
      key: string | undefined,
      expectedVersion: number | undefined,
      mutate: (current: HarnessListing | null) => Omit<HarnessListing, "version">,
    ): Readonly<{ version: number; replayed: boolean }> {
      const receipt = key === undefined ? undefined : receipts.get(key);
      if (receipt !== undefined) return { version: receipt, replayed: true };
      const current = listings.get(listingId) ?? null;
      const version = current?.version ?? 0;
      if ((expectedVersion !== undefined && expectedVersion !== version) || (kind === "create" && current))
        throw Object.assign(new Error("Listing changed after the decision"), { code: "concurrency_conflict" });
      writes.push(`${kind}@${version}:${key ?? "unkeyed"}`);
      const next = { ...mutate(current), version: version + 1 };
      listings.set(listingId, next);
      if (key !== undefined) receipts.set(key, next.version);
      return { version: next.version, replayed: false };
    },
    foreignWrite() {
      const [listingId, listing] = [...listings][0] ?? [];
      if (!listingId || !listing) throw new Error("No Listing to change.");
      writes.push(`foreign@${listing.version}`);
      listings.set(listingId, { ...listing, version: listing.version + 1 });
    },
  };
}

function listingHarness(
  existing: string | ListingHarnessRow | readonly ListingHarnessRow[] | null,
  store: ReturnType<typeof listingStore> = listingStore(existing),
) {
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const published: unknown[] = [];
  const queries: QueryCall[] = [];
  const own: string[] = [];
  let crashPoint: "create" | "publish" | "price" | null = null;
  let interleave: (() => void) | null = null;
  type KeyedParams = Readonly<{
    listingId?: string;
    listingIdOverride?: string;
    idempotencyKey?: string;
    expectedVersion?: number;
  }>;
  const keyed = (
    kind: "create" | "publish" | "price",
    params: KeyedParams,
    mutate: (current: HarnessListing | null) => Omit<HarnessListing, "version">,
  ) => {
    const run = interleave;
    interleave = null;
    run?.();
    const listingId = params.listingId ?? params.listingIdOverride ?? "";
    const result = store.apply(kind, listingId, params.idempotencyKey, params.expectedVersion, mutate);
    if (!result.replayed) own.push(`${kind}:${listingId}`);
    if (crashPoint === kind) {
      crashPoint = null;
      throw new Error(`synthetic crash after ${kind}`);
    }
    return { listingId, version: result.version };
  };

  return {
    created,
    updated,
    published,
    queries,
    writes: () => [...own],
    crashAfter: (kind: "create" | "publish" | "price") => {
      crashPoint = kind;
    },
    interleaveBeforeWrite: (write: () => void) => {
      interleave = write;
    },
    services: {
      db: {
        // The drained Listing projection mirrors each stream's version.
        query: async <Row>(sql: string, params?: readonly unknown[]) => {
          queries.push([sql, params]);
          if (sql.includes("FROM marketplace_listing_pages")) {
            const listing = store.read(String(params?.[0]));
            return { rows: listing ? [{ listing_stream_version: listing.version } as Row] : [] };
          }
          return { rows: [] as Row[] };
        },
      },
      listings: {
        readAuthoritativeListing: async ({ listingId }: { listingId: string }) => {
          const listing = store.read(listingId);
          if (!listing) return { kind: "absent" as const };
          const { version, ...state } = listing;
          return { kind: "present" as const, version, state };
        },
        createListing: async (params: KeyedParams & Readonly<{ priceAmount: string; priceCurrencyCode: string }>) => {
          created.push(params);
          const result = keyed("create", params, () => ({
            status: "draft",
            priceAmount: params.priceAmount,
            priceCurrencyCode: params.priceCurrencyCode,
            feeQuoteFingerprint: "fee_1",
          }));
          return { ...result, feeQuoteFingerprint: "fee_1" };
        },
        updateListingPrice: async (
          params: KeyedParams & Readonly<{ priceAmount: string; priceCurrencyCode: string }>,
        ) => {
          updated.push(params);
          return keyed("price", params, (current) => ({
            status: current?.status ?? "active",
            priceAmount: params.priceAmount,
            priceCurrencyCode: params.priceCurrencyCode,
            feeQuoteFingerprint: current?.feeQuoteFingerprint ?? null,
          }));
        },
        publishListing: async (params: KeyedParams) => {
          published.push(params);
          return keyed("publish", params, (current) => ({
            status: "active",
            priceAmount: current?.priceAmount ?? null,
            priceCurrencyCode: current?.priceCurrencyCode ?? null,
            feeQuoteFingerprint: current?.feeQuoteFingerprint ?? null,
          }));
        },
      },
    },
  };
}

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
