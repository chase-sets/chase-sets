import { getProjectionGroup, syncProjectionGroup } from "@chase-sets/bounded-context-runtime";
import {
  acceptRepresentativeOffers,
  ensureRepresentativeInventoryStock,
  filterUntouchedMarketplaceCatalogUsageCandidates,
  prepareRepresentativeCatalogUsageCandidates,
  publishRepresentativeListings,
  reconcileRepresentativeDiscoveryMarketState,
  reconcileRepresentativeInventoryCatalogItems,
  reconcileRepresentativeMarketplaceCatalogItems,
  reconcileRepresentativeOrderingSupplyState,
  submitRepresentativeOffers,
  type CatalogRepresentativeCatalogUsageCandidate,
  type CatalogRepresentativeServices,
  type MarketplaceRepresentativeListingResult,
  type MarketplaceRepresentativeOfferAcceptanceResult,
  type MarketplaceRepresentativeOfferResult,
  type RepresentativeInventoryServices,
  type RepresentativeInventoryStockResult,
  type RepresentativeMarketplaceServices,
} from "@chase-sets/catalog-seed";
import type { ProductMeasureSnapshot } from "@chase-sets/product-measures";
import { beforeAll, expect, it } from "vitest";
import {
  describeWithMarketplaceSeedDatabase,
  useMarketplaceSeedRuntime,
  type MarketplaceSeedRuntimePools,
} from "../index";

const representativeCatalogItem = {
  catalogItemId: "cat_repr_consolidated_card",
  blueprintId: "bp_repr_consolidated_card",
  formDimensionId: "dim_repr_form",
  conditionDimensionId: "dim_repr_condition",
  rawOptionId: "opt_repr_raw",
  nearMintOptionId: "opt_repr_near_mint",
  title: "Consolidated Representative Card",
  subtitle: "Seed testing 1/1",
  updatedAt: "2030-01-01T00:00:00.000Z",
} as const;

type RepresentativeCommerceStateRun = Readonly<{
  candidates: readonly CatalogRepresentativeCatalogUsageCandidate[];
  stock: readonly RepresentativeInventoryStockResult[];
  listings: readonly MarketplaceRepresentativeListingResult[];
  offers: readonly MarketplaceRepresentativeOfferResult[];
  acceptedOffers: readonly MarketplaceRepresentativeOfferAcceptanceResult[];
  orderingSupply: Awaited<ReturnType<typeof reconcileRepresentativeOrderingSupplyState>>;
  discovery: Awaited<ReturnType<typeof reconcileRepresentativeDiscoveryMarketState>>;
}>;

describeWithMarketplaceSeedDatabase("representative commerce state", () => {
  const seedRuntime = useMarketplaceSeedRuntime("representative-commerce-state", { resetSchemas: "beforeAll" });
  let run: RepresentativeCommerceStateRun | null = null;

  beforeAll(async () => {
    const runtime = await seedRuntime.seed();
    await insertRepresentativeCatalogSource(seedRuntime.pools);

    const sourceCandidates = await prepareRepresentativeCatalogUsageCandidates(getCatalogServices(runtime.services), {
      limit: 1,
    });
    const candidates = await filterUntouchedMarketplaceCatalogUsageCandidates(
      seedRuntime.pools.marketplace,
      sourceCandidates,
      {
        limit: 1,
      },
    );
    if (candidates[0]?.catalogItemId !== representativeCatalogItem.catalogItemId) {
      throw new Error("Representative commerce state test source Catalog Item was not selected.");
    }

    await reconcileRepresentativeMarketplaceCatalogItems(seedRuntime.pools.marketplace, candidates);
    await reconcileRepresentativeInventoryCatalogItems(getInventoryServices(runtime.services), candidates);
    const stock = await ensureRepresentativeInventoryStock(getInventoryServices(runtime.services), candidates);
    if (stock.length !== 1) {
      throw new Error("Representative commerce state test did not create Inventory stock.");
    }

    await syncRepresentativeProjection(runtime, "inventory", "inventory-item-projection");
    await syncRepresentativeProjection(runtime, "inventory", "inventory-hold-projection");
    await syncRepresentativeProjection(runtime, "marketplace", "marketplace-inventory-supply-projection");
    await syncRepresentativeProjection(runtime, "ordering", "ordering-inventory-supply-input-projection");
    const listings = await publishRepresentativeListings(getMarketplaceServices(runtime.services), stock);
    await syncRepresentativeProjection(runtime, "marketplace", "marketplace-listing-projection");
    await syncRepresentativeProjection(runtime, "ordering", "ordering-marketplace-supply-input-projection");
    const offers = await submitRepresentativeOffers(getMarketplaceServices(runtime.services), stock);
    await syncRepresentativeProjection(runtime, "marketplace", "marketplace-offer-projection");
    const acceptedOffers = await acceptRepresentativeOffers(getMarketplaceServices(runtime.services), stock);
    await syncRepresentativeProjection(runtime, "marketplace", "marketplace-offer-projection");
    const orderingSupply = await reconcileRepresentativeOrderingSupplyState(
      {
        inventoryDb: seedRuntime.pools.inventory,
        marketplaceDb: seedRuntime.pools.marketplace,
        orderingDb: seedRuntime.pools.ordering,
      },
      {
        listingIds: listings.map((listing) => listing.listingId),
      },
    );
    const discovery = await reconcileRepresentativeDiscoveryMarketState(
      {
        discoveryDb: seedRuntime.pools.discovery,
        marketplaceDb: seedRuntime.pools.marketplace,
      },
      {
        listingIds: listings.map((listing) => listing.listingId),
        offerIds: offers.map((offer) => offer.offerId),
      },
    );

    run = { candidates, stock, listings, offers, acceptedOffers, orderingSupply, discovery };
  }, 300_000);

  it("loads the current Catalog Item with product schema and resolved measures", () => {
    const candidate = requireRepresentativeRun().candidates[0];

    expect(candidate).toMatchObject({
      catalogItemId: representativeCatalogItem.catalogItemId,
      languageCode: "en",
      title: representativeCatalogItem.title,
      subtitle: representativeCatalogItem.subtitle,
      status: "active",
      productSchema: {
        canonicalDimensionOrder: [
          { dimensionId: representativeCatalogItem.formDimensionId, dimensionName: "Form" },
          { dimensionId: representativeCatalogItem.conditionDimensionId, dimensionName: "Condition" },
        ],
      },
    });
    expect(candidate?.productMeasureSnapshots).toEqual([
      expect.objectContaining({
        catalogItemId: representativeCatalogItem.catalogItemId,
        productId: representativeProductId(),
      }),
    ]);
  });

  it("reconciles selected Catalog facts and representative stock into Inventory read models", async () => {
    const state = requireRepresentativeRun();
    const catalogProjection = await seedRuntime.pools.inventory.query<{
      title: string;
      status: string;
      product_schema: unknown;
    }>(
      `SELECT title, status, product_schema
       FROM inventory_catalog_items
       WHERE catalog_item_id = $1`,
      [representativeCatalogItem.catalogItemId],
    );
    const inventoryItems = await seedRuntime.pools.inventory.query<{
      account_id: string;
      product_id: string;
      selected_options: unknown;
      total_quantity: number;
    }>(
      `SELECT account_id, product_id, selected_options, total_quantity
       FROM inventory_items
       WHERE catalog_catalog_item_id = $1`,
      [representativeCatalogItem.catalogItemId],
    );

    expect(catalogProjection.rows[0]).toMatchObject({
      title: representativeCatalogItem.title,
      status: "active",
    });
    expect(catalogProjection.rows[0]?.product_schema).toEqual(
      expect.objectContaining({ dimensions: expect.any(Array) }),
    );
    expect(inventoryItems.rows[0]).toMatchObject({
      account_id: state.stock[0]?.accountId,
      product_id: representativeProductId(),
      total_quantity: 4,
    });
    expect(inventoryItems.rows[0]?.selected_options).toEqual(expect.arrayContaining(representativeSelectedOptions()));
  });

  it("publishes active Marketplace listings and accepted offers for the representative stock", async () => {
    const state = requireRepresentativeRun();
    const listingId = state.listings[0]?.listingId;
    const offerId = state.offers[0]?.offerId;
    const listing = await seedRuntime.pools.marketplace.query<{
      listing_id: string;
      status: string;
      catalog_catalog_item_id: string;
      product_id: string;
      selected_options: unknown;
      quantity_cap: number;
      evidence: unknown;
    }>(
      `SELECT listing_id, status, catalog_catalog_item_id, product_id, selected_options, quantity_cap, evidence
       FROM marketplace_listing_pages
       WHERE listing_id = $1`,
      [listingId],
    );
    const offer = await seedRuntime.pools.marketplace.query<{
      offer_id: string;
      status: string;
      catalog_catalog_item_id: string;
      product_id: string;
      selected_options: unknown;
      accepted_seller_account_id: string | null;
    }>(
      `SELECT offer_id, status, catalog_catalog_item_id, product_id, selected_options, accepted_seller_account_id
       FROM marketplace_offer_pages
       WHERE offer_id = $1`,
      [offerId],
    );

    expect(state.listings).toEqual([
      expect.objectContaining({ catalogItemId: representativeCatalogItem.catalogItemId, status: "created" }),
    ]);
    expect(state.offers).toEqual([
      expect.objectContaining({ catalogItemId: representativeCatalogItem.catalogItemId, status: "created" }),
    ]);
    expect(state.acceptedOffers).toEqual([
      expect.objectContaining({ catalogItemId: representativeCatalogItem.catalogItemId, status: "accepted" }),
    ]);
    expect(listing.rows[0]).toMatchObject({
      status: "active",
      catalog_catalog_item_id: representativeCatalogItem.catalogItemId,
      product_id: representativeProductId(),
      quantity_cap: 2,
    });
    expect(listing.rows[0]?.selected_options).toEqual(expect.arrayContaining(representativeSelectedOptions()));
    expect(listing.rows[0]?.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ altText: expect.any(String) })]),
    );
    expect(offer.rows[0]).toMatchObject({
      status: "accepted",
      catalog_catalog_item_id: representativeCatalogItem.catalogItemId,
      product_id: representativeProductId(),
      accepted_seller_account_id: state.stock[0]?.accountId,
    });
    expect(offer.rows[0]?.selected_options).toEqual(expect.arrayContaining(representativeSelectedOptions()));
  });

  it("reconciles representative listings into Ordering checkout supply inputs", async () => {
    const state = requireRepresentativeRun();
    const listingId = state.listings[0]?.listingId;
    expect(state.orderingSupply).toMatchObject({
      listingCount: 1,
      inventoryItemCount: 1,
      inventoryHoldCount: 0,
    });
    const supply = await seedRuntime.pools.ordering.query<{
      listing_id: string;
      status: string;
      seller_listing_availability_status: string;
      terms_resolved_at: string | null;
      product_measure_snapshot: unknown;
      total_quantity: number;
      available_quantity: number;
    }>(
      `SELECT
         listing.listing_id,
         listing.status,
         listing.seller_listing_availability_status,
         listing.terms_resolved_at::text AS terms_resolved_at,
         listing.product_measure_snapshot,
         item.total_quantity,
         LEAST(
           listing.quantity_cap,
           GREATEST(item.total_quantity - COALESCE(active_holds.held_quantity, 0), 0)
         ) AS available_quantity
       FROM ordering_market_listing_inputs AS listing
       INNER JOIN ordering_inventory_item_inputs AS item
         ON item.item_id = listing.inventory_item_id
       LEFT JOIN (
         SELECT item_id, SUM(quantity)::integer AS held_quantity
         FROM ordering_inventory_hold_inputs
         WHERE status = 'active'
         GROUP BY item_id
       ) AS active_holds
         ON active_holds.item_id = item.item_id
       WHERE listing.listing_id = $1`,
      [listingId],
    );

    expect(supply.rows[0]).toMatchObject({
      listing_id: listingId,
      status: "active",
      seller_listing_availability_status: "available",
      terms_resolved_at: expect.any(String),
      total_quantity: 4,
      available_quantity: 2,
    });
    expect(supply.rows[0]?.product_measure_snapshot).toEqual(
      expect.objectContaining({ productId: representativeProductId() }),
    );
  });

  it("reconciles the representative marketplace facts into Discovery market read models", async () => {
    const state = requireRepresentativeRun();
    const discoveryListing = await seedRuntime.pools.discovery.query<{
      listing_id: string;
      listing_slug: string;
      product_slug: string;
      status: string;
      catalog_catalog_item_id: string;
      selected_options: unknown;
    }>(
      `SELECT listing_id, listing_slug, product_slug, status, catalog_catalog_item_id, selected_options
       FROM discovery_market_listings
       WHERE listing_id = $1`,
      [state.listings[0]?.listingId],
    );
    const discoveryOffer = await seedRuntime.pools.discovery.query<{
      offer_id: string;
      status: string;
      accepted_seller_account_id: string | null;
    }>(
      `SELECT offer_id, status, accepted_seller_account_id
       FROM discovery_offer_demand_matches
       WHERE offer_id = $1`,
      [state.offers[0]?.offerId],
    );
    const discoveryAccounts = await seedRuntime.pools.discovery.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM discovery_market_accounts
       WHERE account_id = ANY($1::text[])`,
      [[state.stock[0]?.accountId, state.offers[0]?.buyerAccountId]],
    );

    expect(state.discovery).toEqual({ accountCount: 2, listingCount: 1, offerCount: 1 });
    expect(discoveryAccounts.rows[0]?.count).toBe("2");
    expect(discoveryListing.rows[0]).toMatchObject({
      status: "active",
      catalog_catalog_item_id: representativeCatalogItem.catalogItemId,
    });
    expect(discoveryListing.rows[0]?.selected_options).toEqual(expect.arrayContaining(representativeSelectedOptions()));
    expect(discoveryListing.rows[0]?.listing_slug).not.toBe("");
    expect(discoveryListing.rows[0]?.product_slug).not.toBe("");
    expect(discoveryOffer.rows[0]).toMatchObject({
      status: "accepted",
      accepted_seller_account_id: state.stock[0]?.accountId,
    });
  });

  function requireRepresentativeRun(): RepresentativeCommerceStateRun {
    if (!run) {
      throw new Error("Representative commerce state run is not initialized.");
    }

    return run;
  }
});

async function insertRepresentativeCatalogSource(pools: MarketplaceSeedRuntimePools): Promise<void> {
  await pools.catalog.query(
    `INSERT INTO catalog_blueprints (
       blueprint_id,
       key,
       name,
       description,
       status,
       dimension_rules,
       canonical_dimension_order,
       updated_at
     ) VALUES ($1, $2, $3, $4, 'active', $5::jsonb, $6::jsonb, $7)
     ON CONFLICT (blueprint_id) DO UPDATE SET
       status = EXCLUDED.status,
       dimension_rules = EXCLUDED.dimension_rules,
       canonical_dimension_order = EXCLUDED.canonical_dimension_order,
       updated_at = EXCLUDED.updated_at`,
    [
      representativeCatalogItem.blueprintId,
      "representative-consolidated-card",
      "Representative Consolidated Card",
      "Representative commerce state test blueprint",
      JSON.stringify([
        {
          dimensionId: representativeCatalogItem.formDimensionId,
          required: true,
          allowedOptionIds: [representativeCatalogItem.rawOptionId],
        },
        {
          dimensionId: representativeCatalogItem.conditionDimensionId,
          required: true,
          appliesWhen: [
            {
              dimensionId: representativeCatalogItem.formDimensionId,
              optionIds: [representativeCatalogItem.rawOptionId],
            },
          ],
          allowedOptionIds: [representativeCatalogItem.nearMintOptionId],
        },
      ]),
      JSON.stringify([representativeCatalogItem.formDimensionId, representativeCatalogItem.conditionDimensionId]),
      representativeCatalogItem.updatedAt,
    ],
  );
  await pools.catalog.query(
    `INSERT INTO catalog_dimensions (dimension_id, key, name, description, status, updated_at)
     VALUES ($1, 'representative-form', 'Form', '', 'active', $3),
            ($2, 'representative-condition', 'Condition', '', 'active', $3)
     ON CONFLICT (dimension_id) DO UPDATE SET
       name = EXCLUDED.name,
       status = EXCLUDED.status,
       updated_at = EXCLUDED.updated_at`,
    [
      representativeCatalogItem.formDimensionId,
      representativeCatalogItem.conditionDimensionId,
      representativeCatalogItem.updatedAt,
    ],
  );
  await pools.catalog.query(
    `INSERT INTO catalog_dimension_options (dimension_id, option_id, code, label, display_order, status)
     VALUES ($1, $2, 'raw', 'Raw', 1, 'active'),
            ($3, $4, 'near-mint', 'Near Mint', 1, 'active')
     ON CONFLICT (dimension_id, option_id) DO UPDATE SET
       code = EXCLUDED.code,
       label = EXCLUDED.label,
       status = EXCLUDED.status`,
    [
      representativeCatalogItem.formDimensionId,
      representativeCatalogItem.rawOptionId,
      representativeCatalogItem.conditionDimensionId,
      representativeCatalogItem.nearMintOptionId,
    ],
  );
  await pools.catalog.query(
    `INSERT INTO catalog_items (
       catalog_item_id,
       language_code,
       title,
       subtitle,
       description,
       blueprint_id,
       status,
       updated_at
     ) VALUES ($1, 'en', $2, $3, '', $4, 'active', $5)
     ON CONFLICT (catalog_item_id) DO UPDATE SET
       title = EXCLUDED.title,
       subtitle = EXCLUDED.subtitle,
       blueprint_id = EXCLUDED.blueprint_id,
       status = EXCLUDED.status,
       updated_at = EXCLUDED.updated_at`,
    [
      representativeCatalogItem.catalogItemId,
      representativeCatalogItem.title,
      representativeCatalogItem.subtitle,
      representativeCatalogItem.blueprintId,
      representativeCatalogItem.updatedAt,
    ],
  );
  await pools.catalog.query(
    `INSERT INTO catalog_resolved_product_measures (
       product_id,
       catalog_item_id,
       selected_options,
       measure_snapshot,
       updated_at
     ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
     ON CONFLICT (product_id) DO UPDATE SET
       selected_options = EXCLUDED.selected_options,
       measure_snapshot = EXCLUDED.measure_snapshot,
       updated_at = EXCLUDED.updated_at`,
    [
      representativeProductId(),
      representativeCatalogItem.catalogItemId,
      JSON.stringify(representativeSelectedOptions()),
      JSON.stringify(representativeMeasureSnapshot()),
      representativeCatalogItem.updatedAt,
    ],
  );
}

async function syncRepresentativeProjection(
  runtime: Awaited<ReturnType<ReturnType<typeof useMarketplaceSeedRuntime>["seed"]>>,
  contextName: string,
  projectionName: string,
): Promise<void> {
  await syncProjectionGroup(getProjectionGroup(runtime, contextName, projectionName));
}

function getCatalogServices(services: Readonly<Record<string, unknown>>): CatalogRepresentativeServices {
  return services.catalog as CatalogRepresentativeServices;
}

function getInventoryServices(services: Readonly<Record<string, unknown>>): RepresentativeInventoryServices {
  return services.inventory as RepresentativeInventoryServices;
}

function getMarketplaceServices(services: Readonly<Record<string, unknown>>): RepresentativeMarketplaceServices {
  return services.marketplace as RepresentativeMarketplaceServices;
}

function representativeSelectedOptions() {
  return [
    { dimensionId: representativeCatalogItem.formDimensionId, optionId: representativeCatalogItem.rawOptionId },
    {
      dimensionId: representativeCatalogItem.conditionDimensionId,
      optionId: representativeCatalogItem.nearMintOptionId,
    },
  ];
}

function representativeProductId(): string {
  return `${representativeCatalogItem.catalogItemId}::${representativeCatalogItem.formDimensionId}:${representativeCatalogItem.rawOptionId}|${representativeCatalogItem.conditionDimensionId}:${representativeCatalogItem.nearMintOptionId}`;
}

function representativeMeasureSnapshot(): ProductMeasureSnapshot {
  return {
    catalogItemId: representativeCatalogItem.catalogItemId,
    productId: representativeProductId(),
    selectedOptions: representativeSelectedOptions(),
    measureVersion: "representative-commerce-state-v1",
    unitLengthInches: 3.5,
    unitWidthInches: 2.5,
    unitHeightInches: 0.02,
    unitWeightOunces: 0.08,
    physicalFlags: ["raw-card"],
    stackBehavior: "stackable-thickness",
    source: "profile",
    confidence: "measured",
  };
}
