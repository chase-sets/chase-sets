import { describe, expect, it, vi } from "vitest";
import { createId } from "@chase-sets/primitives/typed-ids";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { AppendToStreamsIndependentResult, EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createMarketplaceListingRuntime } from "./runtime";
import {
  evaluateListingEvidencePolicy,
  LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
} from "../../listing-evidence-policy/domain/policy";
import {
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type MarketplaceListingEvent,
} from "../domain/domain";
import type { MarketplaceListingFeeLock, MarketplaceListingFeeTermsSnapshot } from "../domain/fee-lock";
import {
  openMarketplaceListingTermsSession,
  requoteMarketplaceListingFeeLock,
} from "../../../support/runtime-support/fee-quotes";

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) => checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, checkpoint) => {
      checkpoints.set(projectorName, checkpoint);
    },
  };
}

const context = {
  tenantId: "tnt_marketplace" as never,
  audit: {
    performedByUserId: "usr_seller" as never,
    forAccountId: "acc_seller" as never,
  },
};

const shipFromAddress = {
  name: "Seller Shipping",
  company: "Chase Sets",
  line1: "1 Warehouse Way",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  phone: "3125550100",
  email: "shipping@example.com",
} as const;

const productMeasureSnapshot = {
  catalogItemId: "cat_1",
  productId: "cat_1::",
  selectedOptions: [],
  measureVersion: "pm_test_v1",
  unitLengthInches: 3.5,
  unitWidthInches: 2.5,
  unitHeightInches: 0.01,
  unitWeightOunces: 0.1,
  physicalFlags: ["raw-card"],
  stackBehavior: "stackable-thickness",
  source: "profile",
  confidence: "measured",
} as const;

const listingPhoto = {
  photoId: "lpho_1",
  originalFilename: "front.png",
  altText: null,
  sortOrder: 0,
  uploadedAt: "2026-05-21T00:00:00.000Z",
  assetSet: {
    kind: "listing-photo",
    sourceHash: "hash_1",
    source: {
      role: "source",
      width: 600,
      height: 840,
      density: null,
      mediaType: "image/webp",
      storageKey: "marketplace/listings/acc_seller/lst_high_dollar/lpho_1/source.webp",
      publicUrl: "https://assets.test/source.webp",
      byteSize: 1234,
      generatedAt: "2026-05-21T00:00:00.000Z",
    },
    variants: [
      {
        role: "catalog-detail",
        width: 480,
        height: 672,
        density: 1,
        mediaType: "image/webp",
        storageKey: "marketplace/listings/acc_seller/lst_high_dollar/lpho_1/detail.webp",
        publicUrl: "https://assets.test/detail.webp",
        byteSize: 900,
        generatedAt: "2026-05-21T00:00:00.000Z",
      },
    ],
  },
} as const;

type DraftRow = {
  intent_id: string;
  anonymous_owner_id: string;
  source_path: string;
  catalog_item_id: string;
  product_id: string;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  price_amount: string;
  price_currency_code: string;
  quantity_cap: number;
  max_units_per_order: number | null;
  max_units_per_day: number | null;
  max_units_per_customer_account: number | null;
  status: "active" | "claimed" | "expired";
  claimed_account_id: string | null;
  claimed_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

function createDraftIntentDb() {
  const rows: DraftRow[] = [];
  const now = () => new Date().toISOString();
  const selectedOptionsMatch = (row: DraftRow, value: unknown) =>
    JSON.stringify(row.selected_options) === String(value);
  const isActive = (row: DraftRow) => row.status === "active" && new Date(row.expires_at).getTime() > Date.now();

  const db = {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("SET status = 'expired'")) {
        const ownerId = String(params[0] ?? "");
        for (const row of rows) {
          if (row.anonymous_owner_id === ownerId && row.status === "active" && !isActive(row)) {
            row.status = "expired";
            row.updated_at = now();
          }
        }
        return { rows: [] };
      }

      if (sql.includes("ORDER BY updated_at DESC")) {
        return {
          rows: rows
            .filter(
              (row) =>
                row.anonymous_owner_id === params[0] &&
                isActive(row) &&
                row.catalog_item_id === params[1] &&
                row.product_id === params[2] &&
                selectedOptionsMatch(row, params[3]) &&
                row.price_amount === params[4] &&
                row.price_currency_code === params[5] &&
                row.quantity_cap === params[6] &&
                row.max_units_per_order === params[7] &&
                row.max_units_per_day === params[8] &&
                row.max_units_per_customer_account === params[9],
            )
            .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
            .slice(0, 1),
        };
      }

      if (sql.includes("SELECT count(*)::text AS count")) {
        return {
          rows: [
            {
              count: String(rows.filter((row) => row.anonymous_owner_id === params[0] && isActive(row)).length),
            },
          ],
        };
      }

      if (sql.includes("INSERT INTO marketplace_anonymous_listing_draft_intents")) {
        const row: DraftRow = {
          intent_id: String(params[0]),
          anonymous_owner_id: String(params[1]),
          source_path: String(params[2]),
          catalog_item_id: String(params[3]),
          product_id: String(params[4]),
          selected_options: JSON.parse(String(params[5])) as DraftRow["selected_options"],
          product_summary: params[6] === null ? null : String(params[6]),
          price_amount: String(params[7]),
          price_currency_code: String(params[8]),
          quantity_cap: Number(params[9]),
          max_units_per_order: params[10] === null ? null : Number(params[10]),
          max_units_per_day: params[11] === null ? null : Number(params[11]),
          max_units_per_customer_account: params[12] === null ? null : Number(params[12]),
          status: "active",
          claimed_account_id: null,
          claimed_at: null,
          expires_at: String(params[13]),
          created_at: now(),
          updated_at: now(),
        };
        rows.push(row);
        return { rows: [row] };
      }

      if (sql.includes("SET source_path = $2")) {
        const row = rows.find((candidate) => candidate.intent_id === params[0]);
        if (!row) {
          return { rows: [] };
        }
        row.source_path = String(params[1]);
        row.product_summary = params[2] === null ? null : String(params[2]);
        row.expires_at = String(params[3]);
        row.updated_at = now();
        return { rows: [row] };
      }

      if (sql.includes("SET status = 'claimed'")) {
        const row = rows.find(
          (candidate) => candidate.intent_id === params[0] && candidate.anonymous_owner_id === params[1],
        );
        if (!row || !isActive(row)) {
          return { rows: [] };
        }
        row.status = "claimed";
        row.claimed_account_id = String(params[2]);
        row.claimed_at = now();
        row.updated_at = now();
        return { rows: [row] };
      }

      if (sql.includes("WHERE intent_id = $1") && sql.includes("anonymous_owner_id = $2")) {
        return {
          rows: rows.filter((row) => row.intent_id === params[0] && row.anonymous_owner_id === params[1]).slice(0, 1),
        };
      }

      throw new Error(`Unexpected query in test: ${sql}`);
    }),
  };

  return { db, rows };
}

describe("marketplace listing runtime", () => {
  it("deduplicates and claims anonymous listing draft intents without creating listing events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T00:00:00.000Z"));
    const { eventStore } = createInMemoryEventStore();
    const { db, rows } = createDraftIntentDb();
    const services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      commercialTermsResolver: {
        resolveListingTerms: vi.fn(),
      } as never,
    });

    try {
      const first = await services.createAnonymousListingDraftIntent({
        anonymousOwnerId: "anon_listing_draft",
        sourcePath: "/items/charizard?market=sell",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form:raw",
        selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
        productSummary: "Form: Raw",
        priceAmount: "20",
        priceCurrencyCode: "USD",
        quantityCap: 1,
      });
      const second = await services.createAnonymousListingDraftIntent({
        anonymousOwnerId: "anon_listing_draft",
        sourcePath: "/items/charizard-base-set?market=sell",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form:raw",
        selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
        productSummary: "Form: Raw",
        priceAmount: "20.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
      });

      expect(second.intent_id).toBe(first.intent_id);
      expect(rows).toHaveLength(1);
      expect(await eventStore.readAll()).toEqual([]);

      const claimed = await services.claimAnonymousListingDraftIntent({
        anonymousOwnerId: "anon_listing_draft",
        intentId: first.intent_id,
        accountId: "acc_seller",
      });

      expect(claimed).toMatchObject({
        intent_id: first.intent_id,
        status: "claimed",
        claimed_account_id: "acc_seller",
        price_amount: "20.00",
      });
      await expect(
        services.claimAnonymousListingDraftIntent({
          anonymousOwnerId: "anon_listing_draft",
          intentId: first.intent_id,
          accountId: "acc_seller",
        }),
      ).resolves.toMatchObject({ status: "claimed" });
      await expect(
        services.claimAnonymousListingDraftIntent({
          anonymousOwnerId: "anon_listing_draft",
          intentId: first.intent_id,
          accountId: "acc_other",
        }),
      ).rejects.toThrow("Listing draft is no longer available.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes a newly created listing before projections catch up", async () => {
    const { allEvents, eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM marketplace_supply_items AS item")) {
          return {
            rows: [
              {
                item_id: "inv_1",
                account_id: "acc_seller",
                catalog_catalog_item_id: "cat_1",
                product_id: "cat_1::",
                item_title: "Charizard",
                item_subtitle: null,
                selected_options: [],
                product_summary: null,
                product_measure_snapshot: productMeasureSnapshot,
                storage_location_name: "North shelf",
                ship_from_code: "CHI",
                ship_from_address: shipFromAddress,
                available_quantity: 2,
              },
            ],
          };
        }

        if (sql.includes("COALESCE(SUM(quantity_cap), 0)::text AS quantity_cap")) {
          return {
            rows: [{ quantity_cap: "0" }],
          };
        }

        throw new Error(`Unexpected query in test: ${sql}`);
      }),
    };

    const services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      commercialTermsResolver: {
        resolveListingTerms: vi.fn(async ({ amount, accountId }) => ({
          accountId,
          accountType: "business" as const,
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "1.00",
          sellerNetUnitAmount: "19.00",
          scheduleId: "cts_default",
          agreementId: null,
          resolvedAt: "2026-04-17T00:00:00.000Z",
        })),
      } as never,
    });

    const { result, metadata } = await runWithEventCommitMetadata(async () => {
      await services.createListing(
        {
          accountId: "acc_seller" as never,
          inventoryItemId: "inv_1",
          priceAmount: "20.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          listingIdOverride: "lst_seed_1" as never,
        },
        context,
      );

      const preview = await services.previewListingTerms({
        accountId: "acc_seller",
        priceAmount: "20.00",
      });

      const result = await services.publishListing(
        {
          accountId: "acc_seller",
          listingId: "lst_seed_1",
          feeQuoteFingerprint: preview.fee_quote_fingerprint,
        },
        context,
      );

      return { result, metadata: getEventCommitMetadata() };
    });

    expect(result).toEqual({
      listingId: "lst_seed_1",
      version: 3,
    });
    expect(metadata).toEqual({
      eventIds: allEvents.map((event) => event.eventId),
      maxGlobalPosition: allEvents.at(-1)?.globalPosition,
      committedEvents: allEvents,
      sources: [
        {
          sourceContextName: "marketplace",
          eventIds: allEvents.map((event) => event.eventId),
          maxGlobalPosition: allEvents.at(-1)?.globalPosition,
        },
      ],
    });
  });

  it("allows only one concurrent publish when two listing caps compete for the final inventory unit", async () => {
    const { eventStore, streams } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM marketplace_supply_items AS item")) {
          return {
            rows: [
              {
                item_id: "inv_1",
                account_id: "acc_seller",
                catalog_catalog_item_id: "cat_1",
                product_id: "cat_1::",
                item_title: "Charizard",
                item_subtitle: null,
                selected_options: [],
                product_summary: null,
                product_measure_snapshot: productMeasureSnapshot,
                storage_location_name: "North shelf",
                ship_from_code: "CHI",
                ship_from_address: shipFromAddress,
                available_quantity: 1,
              },
            ],
          };
        }
        if (sql.includes("COALESCE(SUM(quantity_cap), 0)::text AS quantity_cap")) {
          return { rows: [{ quantity_cap: "0" }] };
        }
        throw new Error(`Unexpected query in test: ${sql}`);
      }),
    };
    const services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      commercialTermsResolver: {
        resolveListingTerms: vi.fn(async ({ amount, accountId }) => ({
          accountId,
          accountType: "business" as const,
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "1.00",
          sellerNetUnitAmount: "19.00",
          scheduleId: "cts_default",
          agreementId: null,
          resolvedAt: "2026-04-17T00:00:00.000Z",
        })),
      } as never,
    });

    for (const listingId of ["lst_concurrent_1", "lst_concurrent_2"]) {
      await services.createListing(
        {
          accountId: "acc_seller" as never,
          inventoryItemId: "inv_1",
          priceAmount: "20.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          listingIdOverride: listingId as never,
        },
        context,
      );
    }

    const results = await Promise.allSettled(
      ["lst_concurrent_1", "lst_concurrent_2"].map((listingId) =>
        services.publishListing({ accountId: "acc_seller", listingId }, context),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect((rejected?.reason as Error).message).toBe(
      "Active listing quantity caps cannot exceed current sellable inventory.",
    );
    const published = await Promise.all(
      ["lst_concurrent_1", "lst_concurrent_2"].map(
        async (listingId) =>
          (await eventStore.readStream({ streamId: `marketplace.listing-${listingId}` })).filter(
            (event) => event.eventType === "marketplace.listing.published",
          ).length,
      ),
    );
    expect(published).toEqual(expect.arrayContaining([0, 1]));

    streams.delete("marketplace.inventory-listing-capacity-inv_1");
    await services.createListing(
      {
        accountId: "acc_seller" as never,
        inventoryItemId: "inv_1",
        priceAmount: "20.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        listingIdOverride: "lst_after_rollout" as never,
      },
      context,
    );

    await expect(
      services.publishListing({ accountId: "acc_seller", listingId: "lst_after_rollout" }, context),
    ).rejects.toThrow("Active listing quantity caps cannot exceed current sellable inventory.");
  });

  it("suppresses the price-updated event when a recommendation resubmits the current price (no-op)", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM marketplace_supply_items AS item")) {
          return {
            rows: [
              {
                item_id: "inv_1",
                account_id: "acc_seller",
                catalog_catalog_item_id: "cat_1",
                product_id: "cat_1::",
                item_title: "Charizard",
                item_subtitle: null,
                selected_options: [],
                product_summary: null,
                product_measure_snapshot: productMeasureSnapshot,
                storage_location_name: "North shelf",
                ship_from_code: "CHI",
                ship_from_address: shipFromAddress,
                available_quantity: 2,
              },
            ],
          };
        }

        if (sql.includes("COALESCE(SUM(quantity_cap), 0)::text AS quantity_cap")) {
          return {
            rows: [{ quantity_cap: "0" }],
          };
        }

        throw new Error(`Unexpected query in test: ${sql}`);
      }),
    };

    const services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      commercialTermsResolver: {
        resolveListingTerms: vi.fn(async ({ amount, accountId }) => ({
          accountId,
          accountType: "business" as const,
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "1.00",
          sellerNetUnitAmount: "19.00",
          scheduleId: "cts_default",
          agreementId: null,
          resolvedAt: "2026-04-17T00:00:00.000Z",
        })),
      } as never,
    });

    await services.createListing(
      {
        accountId: "acc_seller" as never,
        inventoryItemId: "inv_1",
        priceAmount: "20.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        listingIdOverride: "lst_seed_1" as never,
      },
      context,
    );

    // Mirrors what pricing's applyRecommendations does per row: preview the fee quote for the
    // recommended price, then submit UpdateListingPrice. When the recommendation reproduces the
    // current price (e.g. a bulk-price file with mostly unchanged rows), the domain suppresses
    // the event and the version stays unchanged — the write is free.
    const preview = await services.previewListingTerms({
      accountId: "acc_seller",
      priceAmount: "20.00",
    });

    await expect(
      services.updateListingPrice(
        {
          accountId: "acc_seller",
          listingId: "lst_seed_1",
          priceAmount: "20.00",
          priceCurrencyCode: "USD",
          feeQuoteFingerprint: preview.fee_quote_fingerprint,
        },
        context,
      ),
    ).resolves.toEqual({
      listingId: "lst_seed_1",
      version: 1,
    });

    const streamEvents = await eventStore.readStream({ streamId: "marketplace.listing-lst_seed_1" });
    expect(streamEvents.map((event) => event.eventType)).toEqual(["marketplace.listing.created"]);

    await expect(
      services.updateListingPrice(
        {
          accountId: "acc_seller",
          listingId: "lst_seed_1",
          priceAmount: "20.00",
          priceCurrencyCode: "EUR",
          feeQuoteFingerprint: preview.fee_quote_fingerprint,
        },
        context,
      ),
    ).resolves.toEqual({ listingId: "lst_seed_1", version: 2 });
    await expect(services.loadListingState("lst_seed_1")).resolves.toMatchObject({
      priceAmount: "20.00",
      priceCurrencyCode: "EUR",
    });
  });

  it("rejects publication when inventory supply lacks a resolved shipping measure", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM marketplace_supply_items AS item")) {
          return {
            rows: [
              {
                item_id: "inv_1",
                account_id: "acc_seller",
                catalog_catalog_item_id: "cat_1",
                product_id: "cat_1::",
                item_title: "Charizard",
                item_subtitle: null,
                selected_options: [],
                product_summary: null,
                product_measure_snapshot: null,
                storage_location_name: "North shelf",
                ship_from_code: "CHI",
                ship_from_address: shipFromAddress,
                available_quantity: 2,
              },
            ],
          };
        }

        if (sql.includes("COALESCE(SUM(quantity_cap), 0)::text AS quantity_cap")) {
          return { rows: [{ quantity_cap: "0" }] };
        }

        throw new Error(`Unexpected query in test: ${sql}`);
      }),
    };

    const services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      commercialTermsResolver: {
        resolveListingTerms: vi.fn(async ({ amount, accountId }) => ({
          accountId,
          accountType: "business" as const,
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "1.00",
          sellerNetUnitAmount: "19.00",
          scheduleId: "cts_default",
          agreementId: null,
          resolvedAt: "2026-04-17T00:00:00.000Z",
        })),
      } as never,
    });

    const created = await services.createListing(
      {
        accountId: "acc_seller" as never,
        inventoryItemId: "inv_1",
        priceAmount: "20.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        listingIdOverride: "lst_missing_measure" as never,
      },
      context,
    );

    await expect(
      services.publishListing(
        {
          accountId: "acc_seller",
          listingId: "lst_missing_measure",
          feeQuoteFingerprint: created.feeQuoteFingerprint,
        },
        context,
      ),
    ).rejects.toThrow("Listings require a resolved shipping measure before publication.");
  });

  it("lists fee history from listing events owned by the seller", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM marketplace_supply_items AS item")) {
          return {
            rows: [
              {
                item_id: "inv_1",
                account_id: "acc_seller",
                catalog_catalog_item_id: "cat_1",
                product_id: "cat_1::",
                item_title: "Charizard",
                item_subtitle: null,
                selected_options: [],
                product_summary: null,
                product_measure_snapshot: productMeasureSnapshot,
                storage_location_name: "North shelf",
                ship_from_code: "CHI",
                ship_from_address: shipFromAddress,
                available_quantity: 2,
              },
            ],
          };
        }

        if (sql.includes("COALESCE(SUM(quantity_cap), 0)::text AS quantity_cap")) {
          return { rows: [{ quantity_cap: "0" }] };
        }

        throw new Error(`Unexpected query in test: ${sql}`);
      }),
    };
    const services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      commercialTermsResolver: {
        resolveListingTerms: vi.fn(async ({ amount, accountId }) => ({
          accountId,
          accountType: "business" as const,
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "1.00",
          sellerNetUnitAmount: "19.00",
          scheduleId: "cts_default",
          agreementId: null,
          resolvedAt: "2026-04-17T00:00:00.000Z",
        })),
      } as never,
    });

    const createResult = await services.createListing(
      {
        accountId: "acc_seller" as never,
        inventoryItemId: "inv_1",
        priceAmount: "20.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        listingIdOverride: "lst_history" as never,
      },
      context,
    );
    expect(createResult.version).toBe(1);

    const preview = await services.previewListingTerms({
      accountId: "acc_seller",
      priceAmount: "20.00",
    });
    await services.publishListing(
      {
        accountId: "acc_seller",
        listingId: "lst_history",
        feeQuoteFingerprint: preview.fee_quote_fingerprint,
      },
      context,
    );

    const history = await services.listSellerListingFeeHistory({
      accountId: "acc_seller",
      listingId: "lst_history",
    });

    expect(history).toMatchObject([
      {
        event_type: "marketplace.listing.created",
        stream_version: 1,
        price_amount: "20.00",
        quantity_cap: 1,
        marketplace_sales_fee_unit_amount: "1.00",
        seller_net_unit_amount: "19.00",
      },
    ]);
  });

  it("blocks publication when configured evidence coverage is incomplete", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM marketplace_supply_items AS item")) {
          return {
            rows: [
              {
                item_id: "inv_1",
                account_id: "acc_seller",
                catalog_catalog_item_id: "cat_1",
                product_id: "cat_1::",
                item_title: "Charizard",
                item_subtitle: null,
                selected_options: [],
                product_summary: null,
                product_measure_snapshot: productMeasureSnapshot,
                storage_location_name: "North shelf",
                ship_from_code: "CHI",
                ship_from_address: shipFromAddress,
                available_quantity: 2,
              },
            ],
          };
        }

        if (sql.includes("COALESCE(SUM(quantity_cap), 0)::text AS quantity_cap")) {
          return { rows: [{ quantity_cap: "0" }] };
        }

        if (sql.includes("FROM marketplace_account_pages")) {
          return { rows: [{ account_id: "acc_seller", badges: [], review_count: 0, average_rating: null }] };
        }

        throw new Error(`Unexpected query in test: ${sql}`);
      }),
    };
    const services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      commercialTermsResolver: {
        resolveListingTerms: vi.fn(async ({ amount, accountId }) => ({
          accountId,
          accountType: "business" as const,
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "15.00",
          sellerNetUnitAmount: "285.00",
          scheduleId: "cts_default",
          agreementId: null,
          resolvedAt: "2026-04-17T00:00:00.000Z",
        })),
      } as never,
    });

    const created = await services.createListing(
      {
        accountId: "acc_seller" as never,
        inventoryItemId: "inv_1",
        priceAmount: "300.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        listingIdOverride: "lst_high_dollar" as never,
      },
      context,
    );

    await expect(
      services.publishListing(
        {
          accountId: "acc_seller",
          listingId: "lst_high_dollar",
          feeQuoteFingerprint: created.feeQuoteFingerprint,
        },
        context,
      ),
    ).rejects.toThrow("Listing evidence is incomplete.");
  });

  it("blocks publication when configured seller-trust requirements are incomplete", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM marketplace_supply_items AS item")) {
          return {
            rows: [
              {
                item_id: "inv_1",
                account_id: "acc_seller",
                catalog_catalog_item_id: "cat_1",
                product_id: "cat_1::",
                item_title: "Charizard",
                item_subtitle: null,
                selected_options: [],
                product_summary: null,
                product_measure_snapshot: productMeasureSnapshot,
                storage_location_name: "North shelf",
                ship_from_code: "CHI",
                ship_from_address: shipFromAddress,
                available_quantity: 2,
              },
            ],
          };
        }

        if (sql.includes("COALESCE(SUM(quantity_cap), 0)::text AS quantity_cap")) {
          return { rows: [{ quantity_cap: "0" }] };
        }

        if (sql.includes("FROM marketplace_account_pages")) {
          return { rows: [{ account_id: "acc_seller", badges: [], review_count: 0, average_rating: null }] };
        }

        throw new Error(`Unexpected query in test: ${sql}`);
      }),
    };
    const services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      commercialTermsResolver: {
        resolveListingTerms: vi.fn(async ({ amount, accountId }) => ({
          accountId,
          accountType: "business" as const,
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "15.00",
          sellerNetUnitAmount: "285.00",
          scheduleId: "cts_default",
          agreementId: null,
          resolvedAt: "2026-04-17T00:00:00.000Z",
        })),
      } as never,
    });

    const created = await services.createListing(
      {
        accountId: "acc_seller" as never,
        inventoryItemId: "inv_1",
        priceAmount: "300.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        listingIdOverride: "lst_high_dollar" as never,
      },
      context,
    );

    await services.commandHandler({
      streamId: "marketplace.listing-lst_high_dollar",
      command: {
        type: "AddListingPhotos",
        photos: [listingPhoto],
      },
      context,
      expectedVersion: created.version,
    });

    await expect(
      services.publishListing(
        {
          accountId: "acc_seller",
          listingId: "lst_high_dollar",
          feeQuoteFingerprint: created.feeQuoteFingerprint,
        },
        context,
      ),
    ).rejects.toThrow("Listing evidence is incomplete.");
  });

  it("keeps existing listing fee locks when management changes future terms", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM marketplace_supply_items AS item")) {
          return {
            rows: [
              {
                item_id: "inv_1",
                account_id: "acc_seller",
                catalog_catalog_item_id: "cat_1",
                product_id: "cat_1::",
                item_title: "Charizard",
                item_subtitle: null,
                selected_options: [],
                product_summary: null,
                product_measure_snapshot: productMeasureSnapshot,
                storage_location_name: "North shelf",
                ship_from_code: "CHI",
                ship_from_address: shipFromAddress,
                available_quantity: 4,
              },
            ],
          };
        }

        if (sql.includes("COALESCE(SUM(quantity_cap), 0)::text AS quantity_cap")) {
          return { rows: [{ quantity_cap: "0" }] };
        }

        throw new Error(`Unexpected query in test: ${sql}`);
      }),
    };
    let managedFee = {
      marketplaceSalesFeeUnitAmount: "1.00",
      sellerNetUnitAmount: "19.00",
      scheduleId: "cts_launch",
      resolvedAt: "2026-04-17T00:00:00.000Z",
    };
    const services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      commercialTermsResolver: {
        resolveListingTerms: vi.fn(async ({ amount, accountId }) => ({
          accountId,
          accountType: "business" as const,
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: managedFee.marketplaceSalesFeeUnitAmount,
          sellerNetUnitAmount: managedFee.sellerNetUnitAmount,
          scheduleId: managedFee.scheduleId,
          agreementId: null,
          resolvedAt: managedFee.resolvedAt,
        })),
      } as never,
    });

    const original = await services.createListing(
      {
        accountId: "acc_seller" as never,
        inventoryItemId: "inv_1",
        priceAmount: "20.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        listingIdOverride: "lst_original" as never,
      },
      context,
    );
    await services.publishListing(
      {
        accountId: "acc_seller",
        listingId: "lst_original",
        feeQuoteFingerprint: original.feeQuoteFingerprint,
      },
      context,
    );

    managedFee = {
      marketplaceSalesFeeUnitAmount: "2.00",
      sellerNetUnitAmount: "18.00",
      scheduleId: "cts_after_launch",
      resolvedAt: "2026-04-18T00:00:00.000Z",
    };
    const currentQuote = await services.previewListingTerms({
      accountId: "acc_seller",
      priceAmount: "20.00",
    });
    const newListing = await services.createListing(
      {
        accountId: "acc_seller" as never,
        inventoryItemId: "inv_1",
        priceAmount: "20.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        listingIdOverride: "lst_after_change" as never,
      },
      context,
    );

    const originalHistory = await services.listSellerListingFeeHistory({
      accountId: "acc_seller",
      listingId: "lst_original",
    });
    const newHistory = await services.listSellerListingFeeHistory({
      accountId: "acc_seller",
      listingId: "lst_after_change",
    });

    expect(currentQuote).toMatchObject({
      marketplace_sales_fee_unit_amount: "2.00",
      seller_net_unit_amount: "18.00",
      schedule_id: "cts_after_launch",
    });
    expect(newListing.feeQuoteFingerprint).toBe(currentQuote.fee_quote_fingerprint);
    expect(originalHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "marketplace.listing.created",
          marketplace_sales_fee_unit_amount: "1.00",
          seller_net_unit_amount: "19.00",
          terms_schedule_id: "cts_launch",
        }),
      ]),
    );
    expect(newHistory).toEqual([
      expect.objectContaining({
        event_type: "marketplace.listing.created",
        marketplace_sales_fee_unit_amount: "2.00",
        seller_net_unit_amount: "18.00",
        terms_schedule_id: "cts_after_launch",
      }),
    ]);
  });

  it("creates batch draft listings from committed inventory snapshots with fee terms", async () => {
    const { eventStore } = createInMemoryEventStore();
    const supplyByItemId = new Map<
      string,
      {
        itemId: string;
        accountId: string;
        catalogItemId: string;
        productId: string;
        selectedOptions: readonly { dimensionId: string; optionId: string }[];
        storageLocationName: string;
        shipFromCode: string;
        shipFromAddress: typeof shipFromAddress;
        totalQuantity: number;
      }
    >();
    const resolveListingTerms = vi.fn(async ({ amount, accountId }) => ({
      accountId,
      accountType: "business" as const,
      basisAmount: amount,
      marketplaceSalesFeeUnitAmount: "0.75",
      sellerNetUnitAmount: "4.25",
      scheduleId: "cts_batch",
      agreementId: null,
      resolvedAt: "2026-05-09T00:00:00.000Z",
    }));
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("INSERT INTO marketplace_supply_locations")) {
          return { rows: [] };
        }

        if (sql.includes("INSERT INTO marketplace_supply_items")) {
          supplyByItemId.set(String(values[0]), {
            itemId: String(values[0]),
            accountId: String(values[1]),
            catalogItemId: String(values[2]),
            productId: String(values[3]),
            selectedOptions: JSON.parse(String(values[4])) as readonly {
              dimensionId: string;
              optionId: string;
            }[],
            storageLocationName: "Batch shelf",
            shipFromCode: "CHI",
            shipFromAddress: shipFromAddress,
            totalQuantity: Number(values[6]),
          });
          return { rows: [] };
        }

        if (sql.includes("FROM marketplace_supply_items AS item")) {
          const supply = supplyByItemId.get(String(values[0]));
          return {
            rows: supply
              ? [
                  {
                    item_id: supply.itemId,
                    account_id: supply.accountId,
                    catalog_catalog_item_id: supply.catalogItemId,
                    product_id: supply.productId,
                    item_language_code: "ja",
                    item_title: "Batch card",
                    item_subtitle: null,
                    selected_options: supply.selectedOptions,
                    product_summary: "Condition: Near Mint",
                    product_measure_snapshot: {
                      ...productMeasureSnapshot,
                      catalogItemId: supply.catalogItemId,
                      productId: supply.productId,
                      selectedOptions: supply.selectedOptions,
                    },
                    graded_card: null,
                    storage_location_name: supply.storageLocationName,
                    ship_from_code: supply.shipFromCode,
                    ship_from_address: supply.shipFromAddress,
                    available_quantity: supply.totalQuantity,
                  },
                ]
              : [],
          };
        }

        if (sql.includes("COALESCE(SUM(quantity_cap), 0)::text AS quantity_cap")) {
          return { rows: [{ quantity_cap: "0" }] };
        }

        throw new Error(`Unexpected query in test: ${sql}`);
      }),
    };
    const services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      commercialTermsResolver: {
        resolveListingTerms,
      } as never,
    });

    const result = await services.createBatchDraftListingFromInventorySnapshot(
      {
        accountId: "acc_seller",
        importBatchId: "imb_1",
        importRowId: "imr_1",
        inventoryItemId: "inv_batch",
        listingIdOverride: "lst_batch" as never,
        catalogItemId: "cat_1",
        productId: "cat_1::condition:near_mint",
        selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
        storageLocationId: "loc_1",
        storageLocationName: "Batch shelf",
        shipFromCode: "CHI",
        shipFromAddress: shipFromAddress,
        totalQuantity: 3,
        acquisitionCostAmount: "1.00",
        priceAmount: "5.00",
        priceCurrencyCode: "USD",
        quantityCap: 2,
      },
      context,
    );
    const events = await eventStore.readStream({
      streamId: "marketplace.listing-lst_batch",
    });

    expect(result).toMatchObject({
      listingId: "lst_batch",
      version: 1,
    });
    expect(resolveListingTerms).toHaveBeenCalledWith({
      accountId: "acc_seller",
      amount: "5.00",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "marketplace.listing.created",
      payload: expect.objectContaining({
        listingId: "lst_batch",
        itemLanguageCode: "ja",
        marketplaceSalesFeeUnitAmount: "0.75",
        sellerNetUnitAmount: "4.25",
        termsScheduleId: "cts_batch",
      }),
    });
  });

  it("rejects batch draft listing caps above the committed available inventory", async () => {
    const { eventStore } = createInMemoryEventStore();
    const services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [] })) } as never,
      commercialTermsResolver: {
        resolveListingTerms: vi.fn(),
      } as never,
    });

    await expect(
      services.createBatchDraftListingFromInventorySnapshot(
        {
          accountId: "acc_seller",
          importBatchId: "imb_1",
          importRowId: "imr_1",
          inventoryItemId: "inv_batch",
          listingIdOverride: "lst_batch" as never,
          catalogItemId: "cat_1",
          productId: "cat_1::",
          selectedOptions: [],
          storageLocationId: "loc_1",
          storageLocationName: "Batch shelf",
          shipFromCode: "CHI",
          shipFromAddress: shipFromAddress,
          totalQuantity: 1,
          acquisitionCostAmount: null,
          priceAmount: "5.00",
          priceCurrencyCode: "USD",
          quantityCap: 2,
        },
        context,
      ),
    ).rejects.toThrow("Listing quantity caps cannot exceed created available inventory.");
  });

  it("rejects snapshot listing caps above Inventory-reported available quantity", async () => {
    const { eventStore } = createInMemoryEventStore();
    const services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [] })) } as never,
      commercialTermsResolver: {
        resolveListingTerms: vi.fn(),
      } as never,
    });

    await expect(
      services.createListingFromInventorySnapshot(
        {
          accountId: "acc_seller",
          inventoryItemId: "inv_held",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          selectedOptions: [],
          storageLocationId: "loc_1",
          storageLocationName: "Held shelf",
          shipFromCode: "CHI",
          shipFromAddress,
          totalQuantity: 3,
          availableQuantity: 1,
          acquisitionCostAmount: null,
          priceAmount: "5.00",
          priceCurrencyCode: "USD",
          quantityCap: 2,
        },
        context,
      ),
    ).rejects.toThrow("Listing quantity caps cannot exceed available listing stock.");
  });

  it("uses the compiled Listing Evidence Policy when no policy runtime is wired", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM marketplace_supply_items AS item")) {
          return {
            rows: [
              {
                item_id: "inv_1",
                account_id: "acc_seller",
                catalog_catalog_item_id: "cat_1",
                product_id: "cat_1::",
                item_title: "Charizard",
                item_subtitle: null,
                selected_options: [],
                product_summary: null,
                product_measure_snapshot: productMeasureSnapshot,
                storage_location_name: "North shelf",
                ship_from_code: "CHI",
                ship_from_address: shipFromAddress,
                available_quantity: 2,
              },
            ],
          };
        }

        if (sql.includes("COALESCE(SUM(quantity_cap), 0)::text AS quantity_cap")) {
          return { rows: [{ quantity_cap: "0" }] };
        }

        throw new Error(`Unexpected query in test: ${sql}`);
      }),
    };
    const services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      commercialTermsResolver: {
        resolveListingTerms: vi.fn(async ({ amount, accountId }) => ({
          accountId,
          accountType: "business" as const,
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "5.00",
          sellerNetUnitAmount: "95.00",
          scheduleId: "cts_default",
          agreementId: null,
          resolvedAt: "2026-04-17T00:00:00.000Z",
        })),
      } as never,
    });

    const created = await services.createListing(
      {
        accountId: "acc_seller" as never,
        inventoryItemId: "inv_1",
        priceAmount: "100.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        listingIdOverride: "lst_default_threshold" as never,
      },
      context,
    );

    await expect(
      services.publishListing(
        {
          accountId: "acc_seller",
          listingId: "lst_default_threshold",
          feeQuoteFingerprint: created.feeQuoteFingerprint,
        },
        context,
      ),
    ).resolves.toMatchObject({ listingId: "lst_default_threshold" });
  });

  it("enforces a revised (lower) anonymous listing draft cap from the injected platform-policy runtime", async () => {
    const { db } = createDraftIntentDb();
    const resolvePolicy = vi.fn(async () => ({
      policyKey: "marketplace.listing-gate",
      value: {
        maxActiveAnonymousListingDrafts: 1,
        anonymousListingDraftTtlDays: 30,
        maxListingEvidenceUploadBytes: 10 * 1024 * 1024,
      },
      source: "policy" as const,
      documentId: "pol_listing_gate",
      effectiveFrom: "2026-04-01T00:00:00.000Z",
      effectiveUntil: null,
      resolvedAt: "2026-04-17T00:00:00.000Z",
    }));
    const { eventStore } = createInMemoryEventStore();
    const services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      commercialTermsResolver: {
        resolveListingTerms: vi.fn(),
      } as never,
      policies: { resolvePolicy } as never,
    });

    await services.createAnonymousListingDraftIntent({
      anonymousOwnerId: "anon_capped_draft",
      sourcePath: "/items/charizard?market=sell",
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::form:raw",
      selectedOptions: [],
      priceAmount: "20.00",
      priceCurrencyCode: "USD",
      quantityCap: 1,
    });

    await expect(
      services.createAnonymousListingDraftIntent({
        anonymousOwnerId: "anon_capped_draft",
        sourcePath: "/items/blastoise?market=sell",
        catalogItemId: "cat_blastoise",
        productId: "cat_blastoise::form:raw",
        selectedOptions: [],
        priceAmount: "30.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
      }),
    ).rejects.toThrow(
      "Too many saved listing drafts. Review or finish registration before saving another listing draft.",
    );
    expect(resolvePolicy).toHaveBeenCalledWith(expect.objectContaining({ policyKey: "marketplace.listing-gate" }));
  });

  describe("applyBulkListingPriceUpdates (#4326 chunked multi-listing appends)", () => {
    const syntheticFounderTerms = {
      marketplaceSalesFeePercentageBps: 0,
      marketplaceSalesFeeFixedAmount: "0.00",
      marketplaceSalesFeeCapAmount: null,
      shippingAllowancePercentageBps: 500,
      termsScheduleId: "cts_founders_zero",
      termsAgreementId: "agr_founders",
      termsResolvedAt: "2026-07-01T00:00:00.000Z",
    } as const satisfies MarketplaceListingFeeTermsSnapshot;

    const nonzeroCurrentTerms = {
      marketplaceSalesFeePercentageBps: 900,
      marketplaceSalesFeeFixedAmount: "0.50",
      marketplaceSalesFeeCapAmount: "10.00",
      shippingAllowancePercentageBps: 500,
      termsScheduleId: "cts_current_nonzero",
      termsAgreementId: null,
      termsResolvedAt: "2026-08-01T00:00:00.000Z",
    } as const satisfies MarketplaceListingFeeTermsSnapshot;

    function resolvedTerms(accountId: string, amount: string, terms: MarketplaceListingFeeTermsSnapshot) {
      const lock = requoteMarketplaceListingFeeLock(
        {
          unitCount: 1,
          terms,
          marketplaceSalesFeeUnitAmount: "0.00",
          sellerNetUnitAmount: "0.00",
          feeQuoteFingerprint: "synthetic-before-requote",
        },
        amount,
      );
      return {
        accountId,
        accountType: "business" as const,
        basisAmount: amount,
        marketplaceSalesFeeUnitAmount: lock.marketplaceSalesFeeUnitAmount,
        sellerNetUnitAmount: lock.sellerNetUnitAmount,
        marketplaceSalesFeePercentageBps: terms.marketplaceSalesFeePercentageBps,
        marketplaceSalesFeeFixedAmount: terms.marketplaceSalesFeeFixedAmount,
        marketplaceSalesFeeCapAmount: terms.marketplaceSalesFeeCapAmount,
        shippingAllowancePercentageBps: terms.shippingAllowancePercentageBps,
        scheduleId: terms.termsScheduleId,
        agreementId: terms.termsAgreementId,
        resolvedAt: terms.termsResolvedAt,
      };
    }

    function mutableBulkTermsResolver(initialTerms: MarketplaceListingFeeTermsSnapshot) {
      let currentTerms = initialTerms;
      return {
        useTerms(terms: MarketplaceListingFeeTermsSnapshot) {
          currentTerms = terms;
        },
        resolveListingTerms: vi.fn(async ({ amount, accountId }: { amount: string; accountId: string }) =>
          resolvedTerms(accountId, amount, currentTerms),
        ),
        openListingTermsSession: vi.fn(async ({ accountId }: { accountId: string }) => {
          const sessionTerms = currentTerms;
          return {
            accountId,
            accountType: "business" as const,
            scheduleId: sessionTerms.termsScheduleId,
            agreementId: sessionTerms.termsAgreementId,
            resolvedAt: sessionTerms.termsResolvedAt,
            quote: (amount: string) => resolvedTerms(accountId, amount, sessionTerms),
          };
        }),
      };
    }

    async function readPriceUpdatedPayload(eventStore: EventStore, listingId: string) {
      const events = await eventStore.readStream({ streamId: `marketplace.listing-${listingId}` });
      const event = events.filter((candidate) => candidate.eventType === "marketplace.listing.price-updated").at(-1);
      expect(event).toBeDefined();
      return event!.payload as {
        priceCurrencyCode: string;
        feeLocks: readonly MarketplaceListingFeeLock[];
        feeQuoteFingerprint: string;
        termsScheduleId: string | null;
      };
    }

    function bulkListingsDb() {
      return {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("FROM marketplace_supply_items AS item")) {
            return {
              rows: [
                {
                  item_id: "inv_1",
                  account_id: "acc_seller",
                  catalog_catalog_item_id: "cat_1",
                  product_id: "cat_1::",
                  item_title: "Charizard",
                  item_subtitle: null,
                  selected_options: [],
                  product_summary: null,
                  product_measure_snapshot: productMeasureSnapshot,
                  storage_location_name: "North shelf",
                  ship_from_code: "CHI",
                  ship_from_address: shipFromAddress,
                  available_quantity: 10,
                },
              ],
            };
          }
          if (sql.includes("COALESCE(SUM(quantity_cap), 0)::text AS quantity_cap")) {
            return { rows: [{ quantity_cap: "0" }] };
          }
          throw new Error(`Unexpected query in test: ${sql}`);
        }),
      };
    }

    function bulkTermsResolver() {
      return {
        resolveListingTerms: vi.fn(async ({ amount, accountId }) => ({
          accountId,
          accountType: "business" as const,
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "1.00",
          sellerNetUnitAmount: "19.00",
          scheduleId: "cts_bulk",
          agreementId: null,
          resolvedAt: "2026-07-09T00:00:00.000Z",
        })),
        openListingTermsSession: vi.fn(async ({ accountId }: { accountId: string }) => ({
          accountId,
          accountType: "business" as const,
          scheduleId: "cts_bulk",
          agreementId: null,
          resolvedAt: "2026-07-09T00:00:00.000Z",
          quote: (amount: string) => ({
            accountId,
            accountType: "business" as const,
            basisAmount: amount,
            marketplaceSalesFeeUnitAmount: "1.00",
            sellerNetUnitAmount: "19.00",
            scheduleId: "cts_bulk",
            agreementId: null,
            resolvedAt: "2026-07-09T00:00:00.000Z",
          }),
        })),
      };
    }

    it("creates channel-only without Terms and refuses native publication, Resume, prices, purchase limits and capacity with zero events", async () => {
      const { eventStore } = createInMemoryEventStore();
      const terms = bulkTermsResolver();
      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: bulkListingsDb() as never,
        commercialTermsResolver: terms as never,
      });
      const params = {
        accountId: "acc_seller" as never,
        inventoryItemId: "inv_1",
        priceAmount: "20",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        publicationScope: "channel-only" as const,
        listingIdOverride: "lst_channel" as never,
      };
      const result = await services.createListing(params, context);
      expect(result.state).toEqual(await services.loadListingState("lst_channel"));
      expect(result.state).toMatchObject({
        status: "draft",
        publicationScope: "channel-only",
        nativeVisibility: "disabled",
        nativeFeeState: "not-enrolled",
        priceAmount: "20.00",
        priceCurrencyCode: "USD",
        feeLocks: [],
      });
      const owned = { accountId: "acc_seller", listingId: "lst_channel" };
      for (const command of [
        () => services.publishListing(owned, context),
        () => services.updateListingPrice({ ...owned, priceAmount: "25.00", priceCurrencyCode: "USD" }, context),
        () => services.updateListingQuantityCap({ ...owned, quantityCap: 2 }, context),
        () => services.updateListingPurchaseLimits({ ...owned, purchaseLimits: { maxUnitsPerOrder: 1 } }, context),
      ])
        await expect(command()).rejects.toThrow("channel-only");
      expect(
        await services.applyBulkListingPriceUpdates(
          {
            accountId: "acc_seller",
            updates: [{ listingId: "lst_channel", priceAmount: "25.00", priceCurrencyCode: "USD" }],
          },
          context,
        ),
      ).toMatchObject([{ outcome: "error", message: expect.stringContaining("channel-only") }]);
      expect(terms.resolveListingTerms).not.toHaveBeenCalled();
      expect(terms.openListingTermsSession).not.toHaveBeenCalled();
      expect(await eventStore.readStream({ streamId: "marketplace.listing-lst_channel" })).toHaveLength(1);
      expect(await services.createListing(params, context)).toEqual(result);
      await expect(services.createListing({ ...params, publicationScope: "native" }, context)).rejects.toThrow(
        "scope cannot change",
      );
      await services.withdrawListing(owned, context);
      expect(await services.loadListingState("lst_channel")).toMatchObject({
        status: "withdrawn",
        publicationScope: "channel-only",
      });
    });

    it("preserves a synthetic 0% founder tranche's seven stored terms while changing its price fingerprint", async () => {
      const { eventStore } = createInMemoryEventStore();
      const termsResolver = mutableBulkTermsResolver(syntheticFounderTerms);
      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: bulkListingsDb() as never,
        commercialTermsResolver: termsResolver as never,
      });
      await services.createListing(
        {
          accountId: "acc_seller" as never,
          inventoryItemId: "inv_1",
          priceAmount: "20.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          listingIdOverride: "lst_founder_preserved" as never,
        },
        context,
      );
      const created = await services.loadListingState("lst_founder_preserved");
      termsResolver.useTerms(nonzeroCurrentTerms);

      await expect(
        services.applyBulkListingPriceUpdates(
          {
            accountId: "acc_seller",
            updates: [{ listingId: "lst_founder_preserved", priceAmount: "25.00", priceCurrencyCode: "USD" }],
          },
          context,
        ),
      ).resolves.toEqual([{ listingId: "lst_founder_preserved", outcome: "applied", version: 2 }]);

      await expect(
        services.applyBulkListingPriceUpdates(
          {
            accountId: "acc_seller",
            updates: [{ listingId: "lst_founder_preserved", priceAmount: "25.00", priceCurrencyCode: "EUR" }],
          },
          context,
        ),
      ).resolves.toEqual([{ listingId: "lst_founder_preserved", outcome: "applied", version: 3 }]);

      const payload = await readPriceUpdatedPayload(eventStore, "lst_founder_preserved");
      expect(payload.priceCurrencyCode).toBe("EUR");
      expect(payload.feeLocks[0]?.terms).toEqual(syntheticFounderTerms);
      expect(payload.feeLocks[0]?.terms).toEqual(created.feeLocks[0]?.terms);
      expect(payload.feeQuoteFingerprint).not.toBe(created.feeLocks[0]?.feeQuoteFingerprint);
    });

    it.each([
      {
        name: "recomputes nonzero percentage, fixed, and capped money from the preserved terms",
        storedTerms: {
          marketplaceSalesFeePercentageBps: 1_000,
          marketplaceSalesFeeFixedAmount: "0.50",
          marketplaceSalesFeeCapAmount: "5.00",
          shippingAllowancePercentageBps: 425,
          termsScheduleId: "cts_capped",
          termsAgreementId: "agr_capped",
          termsResolvedAt: "2026-07-02T00:00:00.000Z",
        } satisfies MarketplaceListingFeeTermsSnapshot,
      },
    ])("$name", async ({ storedTerms }) => {
      const { eventStore } = createInMemoryEventStore();
      const termsResolver = mutableBulkTermsResolver(storedTerms);
      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: bulkListingsDb() as never,
        commercialTermsResolver: termsResolver as never,
      });
      await services.createListing(
        {
          accountId: "acc_seller" as never,
          inventoryItemId: "inv_1",
          priceAmount: "20.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          listingIdOverride: "lst_nonzero_requote" as never,
        },
        context,
      );
      const created = await services.loadListingState("lst_nonzero_requote");
      const expected = requoteMarketplaceListingFeeLock(created.feeLocks[0]!, "40.00");
      termsResolver.useTerms(nonzeroCurrentTerms);

      await services.applyBulkListingPriceUpdates(
        {
          accountId: "acc_seller",
          updates: [{ listingId: "lst_nonzero_requote", priceAmount: "40.00", priceCurrencyCode: "USD" }],
        },
        context,
      );

      const lock = (await readPriceUpdatedPayload(eventStore, "lst_nonzero_requote")).feeLocks[0]!;
      expect(lock.terms).toMatchObject({
        marketplaceSalesFeePercentageBps: storedTerms.marketplaceSalesFeePercentageBps,
        marketplaceSalesFeeFixedAmount: storedTerms.marketplaceSalesFeeFixedAmount,
        marketplaceSalesFeeCapAmount: storedTerms.marketplaceSalesFeeCapAmount,
      });
      expect(lock.marketplaceSalesFeeUnitAmount).toBe(expected.marketplaceSalesFeeUnitAmount);
      expect(lock.sellerNetUnitAmount).toBe(expected.sellerNetUnitAmount);
      expect(lock.marketplaceSalesFeeUnitAmount).not.toBe(created.feeLocks[0]?.marketplaceSalesFeeUnitAmount);
      expect(lock.sellerNetUnitAmount).not.toBe(created.feeLocks[0]?.sellerNetUnitAmount);
    });

    it("preserves every tranche's stored terms, unit count, and order independently", async () => {
      const { eventStore } = createInMemoryEventStore();
      const termsResolver = mutableBulkTermsResolver(syntheticFounderTerms);
      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: bulkListingsDb() as never,
        commercialTermsResolver: termsResolver as never,
      });
      await services.createListing(
        {
          accountId: "acc_seller" as never,
          inventoryItemId: "inv_1",
          priceAmount: "20.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          listingIdOverride: "lst_multi_tranche" as never,
        },
        context,
      );
      const restockTerms = {
        ...nonzeroCurrentTerms,
        termsScheduleId: "cts_restock",
        termsAgreementId: "agr_restock",
        termsResolvedAt: "2026-08-02T00:00:00.000Z",
      } satisfies MarketplaceListingFeeTermsSnapshot;
      termsResolver.useTerms(restockTerms);
      const restockQuote = await services.previewListingTerms({ accountId: "acc_seller", priceAmount: "20.00" });
      await services.updateListingQuantityCap(
        {
          accountId: "acc_seller",
          listingId: "lst_multi_tranche",
          quantityCap: 3,
          feeQuoteFingerprint: restockQuote.fee_quote_fingerprint,
        },
        context,
      );
      const before = await services.loadListingState("lst_multi_tranche");
      termsResolver.useTerms({
        ...nonzeroCurrentTerms,
        termsScheduleId: "cts_after_restock",
        termsResolvedAt: "2026-08-03T00:00:00.000Z",
      });

      await services.applyBulkListingPriceUpdates(
        {
          accountId: "acc_seller",
          updates: [{ listingId: "lst_multi_tranche", priceAmount: "30.00", priceCurrencyCode: "USD" }],
        },
        context,
      );

      const locks = (await readPriceUpdatedPayload(eventStore, "lst_multi_tranche")).feeLocks;
      expect(locks.map(({ unitCount, terms }) => ({ unitCount, terms }))).toEqual(
        before.feeLocks.map(({ unitCount, terms }) => ({ unitCount, terms })),
      );
      expect(locks.map((lock) => lock.unitCount)).toEqual([1, 2]);
      expect(locks.map((lock) => lock.terms.termsScheduleId)).toEqual(["cts_founders_zero", "cts_restock"]);
    });

    it.each([
      ["HTTP shape with a current-session fee fingerprint", "http"],
      ["repricing-engine shape with tolerance and idempotency", "repricing-engine"],
      ["recommendations shape with listing id and price", "recommendations"],
      ["bulk-reprice-ingestion shape with listing id and price", "bulk-reprice-ingestion"],
    ] as const)("%s preserves stored tranche terms", async (_name, callerShape) => {
      const { eventStore } = createInMemoryEventStore();
      const termsResolver = mutableBulkTermsResolver(syntheticFounderTerms);
      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: bulkListingsDb() as never,
        commercialTermsResolver: termsResolver as never,
      });
      const listingId = `lst_caller_${callerShape}`;
      await services.createListing(
        {
          accountId: "acc_seller" as never,
          inventoryItemId: "inv_1",
          priceAmount: "20.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          listingIdOverride: listingId as never,
        },
        context,
      );
      termsResolver.useTerms(nonzeroCurrentTerms);
      const currentSession =
        callerShape === "http"
          ? await openMarketplaceListingTermsSession(termsResolver as never, { accountId: "acc_seller" })
          : null;
      const update = {
        listingId,
        priceAmount: "25.00",
        priceCurrencyCode: "USD",
        ...(callerShape === "http"
          ? {
              feeQuoteFingerprint: currentSession!.quote("25.00").fee_quote_fingerprint,
            }
          : {}),
        ...(callerShape === "repricing-engine"
          ? {
              minimumChange: { mode: "absolute" as const, amount: "0.25" },
              idempotencyKey: `repricing:round-1:product-1:${listingId}:price`,
            }
          : {}),
      };

      await expect(
        services.applyBulkListingPriceUpdates({ accountId: "acc_seller", updates: [update] }, context),
      ).resolves.toMatchObject([{ listingId, outcome: "applied" }]);
      expect((await readPriceUpdatedPayload(eventStore, listingId)).feeLocks[0]?.terms).toEqual(syntheticFounderTerms);
    });

    it("does not disclose an existing deterministic listing to another account", async () => {
      const { eventStore } = createInMemoryEventStore();
      const termsResolver = bulkTermsResolver();
      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: bulkListingsDb() as never,
        commercialTermsResolver: termsResolver as never,
      });

      await services.createListing(
        {
          accountId: "acc_seller" as never,
          inventoryItemId: "inv_1",
          priceAmount: "20.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          listingIdOverride: "lst_owned" as never,
        },
        context,
      );

      await expect(
        services.createListing(
          {
            accountId: "acc_intruder" as never,
            inventoryItemId: "inv_1",
            priceAmount: "20.00",
            priceCurrencyCode: "USD",
            quantityCap: 1,
            listingIdOverride: "lst_owned" as never,
          },
          context,
        ),
      ).rejects.toThrow("Listing not found.");
      expect(termsResolver.resolveListingTerms).toHaveBeenCalledTimes(1);
    });

    it("applies changed prices, suppresses no-ops, and isolates a domain error per listing", async () => {
      const { eventStore } = createInMemoryEventStore();
      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: bulkListingsDb() as never,
        commercialTermsResolver: bulkTermsResolver() as never,
      });

      for (const listingId of ["lst_bulk_1", "lst_bulk_2", "lst_bulk_3"]) {
        await services.createListing(
          {
            accountId: "acc_seller" as never,
            inventoryItemId: "inv_1",
            priceAmount: "20.00",
            priceCurrencyCode: "USD",
            quantityCap: 1,
            listingIdOverride: listingId as never,
          },
          context,
        );
      }
      // lst_bulk_3 is withdrawn -- its later bulk price update must isolate to an "error" outcome.
      await services.withdrawListing({ accountId: "acc_seller", listingId: "lst_bulk_3" }, context);

      const [changedQuote, sameQuote, withdrawnQuote] = await Promise.all([
        services.previewListingTerms({ accountId: "acc_seller", priceAmount: "25.00" }),
        services.previewListingTerms({ accountId: "acc_seller", priceAmount: "20.00" }),
        services.previewListingTerms({ accountId: "acc_seller", priceAmount: "30.00" }),
      ]);

      const outcomes = await services.applyBulkListingPriceUpdates(
        {
          accountId: "acc_seller",
          updates: [
            {
              listingId: "lst_bulk_1",
              priceAmount: "25.00",
              priceCurrencyCode: "USD",
              feeQuoteFingerprint: changedQuote.fee_quote_fingerprint,
            },
            {
              listingId: "lst_bulk_2",
              priceAmount: "20.00",
              priceCurrencyCode: "USD",
              feeQuoteFingerprint: sameQuote.fee_quote_fingerprint,
            },
            {
              listingId: "lst_bulk_3",
              priceAmount: "30.00",
              priceCurrencyCode: "USD",
              feeQuoteFingerprint: withdrawnQuote.fee_quote_fingerprint,
            },
          ],
        },
        context,
      );

      expect(outcomes).toEqual([
        { listingId: "lst_bulk_1", outcome: "applied", version: 2 },
        { listingId: "lst_bulk_2", outcome: "no_op", version: 1 },
        {
          listingId: "lst_bulk_3",
          outcome: "error",
          version: 0,
          message: "Withdrawn listings cannot be updated.",
        },
      ]);

      await expect(eventStore.readStream({ streamId: "marketplace.listing-lst_bulk_1" })).resolves.toMatchObject([
        { eventType: "marketplace.listing.created" },
        { eventType: "marketplace.listing.price-updated" },
      ]);
      await expect(eventStore.readStream({ streamId: "marketplace.listing-lst_bulk_2" })).resolves.toHaveLength(1);
      await expect(eventStore.readStream({ streamId: "marketplace.listing-lst_bulk_3" })).resolves.toMatchObject([
        { eventType: "marketplace.listing.created" },
        { eventType: "marketplace.listing.withdrawn" },
      ]);
    });

    it("lets a manual edit win when an automated bulk update carries a stale observed version", async () => {
      const { eventStore } = createInMemoryEventStore();
      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: bulkListingsDb() as never,
        commercialTermsResolver: bulkTermsResolver() as never,
      });
      await services.createListing(
        {
          accountId: "acc_seller" as never,
          inventoryItemId: "inv_1",
          priceAmount: "20.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          listingIdOverride: "lst_manual_wins" as never,
        },
        context,
      );
      await services.updateListingPrice(
        { accountId: "acc_seller", listingId: "lst_manual_wins", priceAmount: "22.00", priceCurrencyCode: "USD" },
        context,
      );

      const outcomes = await services.applyBulkListingPriceUpdates(
        {
          accountId: "acc_seller",
          updates: [
            { listingId: "lst_manual_wins", priceAmount: "18.00", priceCurrencyCode: "USD", expectedVersion: 1 },
          ],
        },
        context,
      );

      expect(outcomes).toEqual([
        {
          listingId: "lst_manual_wins",
          outcome: "conflict",
          version: 2,
          message: "Expected stream version does not match current version.",
        },
      ]);
      await expect(services.loadListingState("lst_manual_wins")).resolves.toMatchObject({ priceAmount: "22.00" });
    });

    it("applies tolerance against Marketplace's authoritative price instead of a stale caller projection", async () => {
      const { eventStore } = createInMemoryEventStore();
      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: bulkListingsDb() as never,
        commercialTermsResolver: bulkTermsResolver() as never,
      });
      await services.createListing(
        {
          accountId: "acc_seller" as never,
          inventoryItemId: "inv_1",
          priceAmount: "10.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          listingIdOverride: "lst_authoritative_tolerance" as never,
        },
        context,
      );

      const outcomes = await services.applyBulkListingPriceUpdates(
        {
          accountId: "acc_seller",
          updates: [
            {
              listingId: "lst_authoritative_tolerance",
              priceAmount: "11.00",
              priceCurrencyCode: "USD",
              expectedVersion: 1,
              minimumChange: { mode: "absolute", amount: "0.25" },
              idempotencyKey: "repricing:round:product:listing:price",
            },
          ],
        },
        context,
      );

      expect(outcomes[0]).toMatchObject({ outcome: "applied" });
      await expect(services.loadListingState("lst_authoritative_tolerance")).resolves.toMatchObject({
        priceAmount: "11.00",
        priceCurrencyCode: "USD",
      });
    });

    it("replays a deterministic repricing mutation after a crash without appending a second move", async () => {
      const { eventStore } = createInMemoryEventStore();
      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: bulkListingsDb() as never,
        commercialTermsResolver: bulkTermsResolver() as never,
      });
      await services.createListing(
        {
          accountId: "acc_seller" as never,
          inventoryItemId: "inv_1",
          priceAmount: "100.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          listingIdOverride: "lst_retry_once" as never,
        },
        context,
      );
      const mutation = {
        accountId: "acc_seller",
        updates: [
          {
            listingId: "lst_retry_once",
            priceAmount: "90.00",
            priceCurrencyCode: "USD",
            expectedVersion: 1,
            minimumChange: { mode: "absolute" as const, amount: "0.25" },
            idempotencyKey: "repricing:round-1:product-1:lst_retry_once:price",
          },
        ],
      };

      await expect(services.applyBulkListingPriceUpdates(mutation, context)).resolves.toMatchObject([
        { outcome: "applied" },
      ]);
      await expect(services.applyBulkListingPriceUpdates(mutation, context)).resolves.toMatchObject([
        { outcome: "applied" },
      ]);
      await expect(eventStore.readStream({ streamId: "marketplace.listing-lst_retry_once" })).resolves.toHaveLength(2);
      await expect(services.loadListingState("lst_retry_once")).resolves.toMatchObject({ priceAmount: "90.00" });
    });

    it("issue-6299-acceptance-control replays and lists fee history through event 501", async () => {
      const { eventStore, streams } = createInMemoryEventStore();
      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: bulkListingsDb() as never,
        commercialTermsResolver: bulkTermsResolver() as never,
      });
      const listingId = "lst_complete_history";
      const idempotencyKey = "repricing:complete-history:lst_complete_history:price";
      await services.createListing(
        {
          accountId: "acc_seller" as never,
          inventoryItemId: "inv_1",
          priceAmount: "100.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          listingIdOverride: listingId as never,
        },
        context,
      );
      const createdPayload = streams.get(`marketplace.listing-${listingId}`)?.[0]?.payload as {
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        shippingAllowancePercentageBps: number;
        termsScheduleId: string | null;
        termsAgreementId: string | null;
        termsResolvedAt: string | null;
        feeQuoteFingerprint: string;
        feeLocks: readonly Record<string, unknown>[];
      };
      if (!createdPayload) {
        throw new Error("Expected the created Listing event.");
      }
      await eventStore.appendToStream({
        streamId: `marketplace.listing-${listingId}`,
        expectedVersion: 1,
        context,
        events: Array.from({ length: 500 }, (_, index) => ({
          ...(index === 499 ? { eventId: `${idempotencyKey}:0` as never } : {}),
          eventType: "marketplace.listing.price-updated",
          payload: {
            priceAmount: "90.00",
            priceCurrencyCode: "USD",
            marketplaceSalesFeeUnitAmount: createdPayload.marketplaceSalesFeeUnitAmount,
            sellerNetUnitAmount: createdPayload.sellerNetUnitAmount,
            shippingAllowancePercentageBps: createdPayload.shippingAllowancePercentageBps,
            termsScheduleId: createdPayload.termsScheduleId,
            termsAgreementId: createdPayload.termsAgreementId,
            termsResolvedAt: createdPayload.termsResolvedAt,
            feeQuoteFingerprint: createdPayload.feeQuoteFingerprint,
            feeLocks: createdPayload.feeLocks as never,
          },
        })),
      });

      await expect(
        services.applyBulkListingPriceUpdates(
          {
            accountId: "acc_seller",
            updates: [
              {
                listingId,
                priceAmount: "90.00",
                priceCurrencyCode: "USD",
                expectedVersion: 501,
                idempotencyKey,
              },
            ],
          },
          context,
        ),
      ).resolves.toEqual([{ listingId, outcome: "applied", version: 501 }]);

      const history = await services.listSellerListingFeeHistory({
        accountId: "acc_seller",
        listingId,
      });
      expect(history).toHaveLength(501);
      expect(history[0]?.stream_version).toBe(501);
      expect(streams.get(`marketplace.listing-${listingId}`)).toHaveLength(501);
    });

    it("isolates an unowned/unknown listing to an error outcome without blocking the rest of the batch", async () => {
      const { eventStore } = createInMemoryEventStore();
      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: bulkListingsDb() as never,
        commercialTermsResolver: bulkTermsResolver() as never,
      });

      await services.createListing(
        {
          accountId: "acc_seller" as never,
          inventoryItemId: "inv_1",
          priceAmount: "20.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          listingIdOverride: "lst_owned" as never,
        },
        context,
      );

      const outcomes = await services.applyBulkListingPriceUpdates(
        {
          accountId: "acc_seller",
          updates: [
            {
              listingId: "lst_does_not_exist",
              priceAmount: "25.00",
              priceCurrencyCode: "USD",
              feeQuoteFingerprint: "stale",
            },
            {
              listingId: "lst_owned",
              priceAmount: "25.00",
              priceCurrencyCode: "USD",
              feeQuoteFingerprint: "stale-too",
            },
          ],
        },
        context,
      );

      expect(outcomes[0]).toMatchObject({ listingId: "lst_does_not_exist", outcome: "error" });
      expect(outcomes[1]).toMatchObject({ listingId: "lst_owned", outcome: "error" });
      await expect(eventStore.readStream({ streamId: "marketplace.listing-lst_owned" })).resolves.toHaveLength(1);
    });

    it("chunks the append according to the resolved marketplace.listing-bulk-price-update policy", async () => {
      const { eventStore } = createInMemoryEventStore();
      const appendSpy = vi.fn(eventStore.appendToStreamsIndependently!);
      const spyEventStore: EventStore = { ...eventStore, appendToStreamsIndependently: appendSpy };
      const resolvePolicy = vi.fn(async (policy: { policyKey: string }) => {
        if (policy.policyKey === "marketplace.listing-bulk-price-update") {
          return {
            policyKey: policy.policyKey,
            value: { chunkSize: 2, yieldIntervalMs: 0 },
            source: "policy" as const,
            documentId: "pol_bulk_chunk",
            effectiveFrom: "2026-07-01T00:00:00.000Z",
            effectiveUntil: null,
            resolvedAt: "2026-07-09T00:00:00.000Z",
          };
        }
        throw new Error(`Unexpected policy resolution in test: ${policy.policyKey}`);
      });

      const services = createMarketplaceListingRuntime({
        eventStore: spyEventStore,
        checkpointStore: createCheckpointStore(),
        db: bulkListingsDb() as never,
        commercialTermsResolver: bulkTermsResolver() as never,
        policies: { resolvePolicy } as never,
      });

      const listingIds = ["lst_chunk_1", "lst_chunk_2", "lst_chunk_3"];
      for (const listingId of listingIds) {
        await services.createListing(
          {
            accountId: "acc_seller" as never,
            inventoryItemId: "inv_1",
            priceAmount: "20.00",
            priceCurrencyCode: "USD",
            quantityCap: 1,
            listingIdOverride: listingId as never,
          },
          context,
        );
      }

      const quotes = await Promise.all(
        listingIds.map((_, index) =>
          services.previewListingTerms({ accountId: "acc_seller", priceAmount: `${21 + index}.00` }),
        ),
      );

      const outcomes = await services.applyBulkListingPriceUpdates(
        {
          accountId: "acc_seller",
          updates: listingIds.map((listingId, index) => ({
            listingId,
            priceAmount: `${21 + index}.00`,
            priceCurrencyCode: "USD",
            feeQuoteFingerprint: quotes[index]!.fee_quote_fingerprint,
          })),
        },
        context,
      );

      expect(outcomes.every((outcome) => outcome.outcome === "applied")).toBe(true);
      // 3 listings at chunkSize 2 -> two appendToStreamsIndependently calls (2 + 1).
      expect(appendSpy).toHaveBeenCalledTimes(2);
      expect(appendSpy.mock.calls[0]?.[0]).toHaveLength(2);
      expect(appendSpy.mock.calls[1]?.[0]).toHaveLength(1);
      expect(resolvePolicy).toHaveBeenCalledWith(
        expect.objectContaining({ policyKey: "marketplace.listing-bulk-price-update" }),
      );
    });

    it("opens one current-terms session for the whole bulk run", async () => {
      const { eventStore } = createInMemoryEventStore();
      const termsResolver = bulkTermsResolver();
      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: bulkListingsDb() as never,
        commercialTermsResolver: termsResolver as never,
      });

      const listingIds = ["lst_session_1", "lst_session_2", "lst_session_3", "lst_session_4", "lst_session_5"];
      for (const listingId of listingIds) {
        await services.createListing(
          {
            accountId: "acc_seller" as never,
            inventoryItemId: "inv_1",
            priceAmount: "20.00",
            priceCurrencyCode: "USD",
            quantityCap: 1,
            listingIdOverride: listingId as never,
          },
          context,
        );
      }

      const outcomes = await services.applyBulkListingPriceUpdates(
        {
          accountId: "acc_seller",
          updates: listingIds.map((listingId, index) => ({
            listingId,
            priceAmount: `${21 + index}.00`,
            priceCurrencyCode: "USD",
          })),
        },
        context,
      );

      expect(outcomes.every((outcome) => outcome.outcome === "applied")).toBe(true);
      expect(termsResolver.openListingTermsSession).toHaveBeenCalledTimes(1);
      expect(termsResolver.openListingTermsSession).toHaveBeenCalledWith({ accountId: "acc_seller" });
    });

    it("preserves stored terms across every chunk while opening one current-terms session for the run", async () => {
      const { eventStore } = createInMemoryEventStore();
      const resolvePolicy = vi.fn(async (policy: { policyKey: string }) => {
        if (policy.policyKey === "marketplace.listing-bulk-price-update") {
          return {
            policyKey: policy.policyKey,
            // chunkSize 1 forces one wave per listing and proves the terms
            // session remains stable across append waves.
            value: { chunkSize: 1, yieldIntervalMs: 0 },
            source: "policy" as const,
            documentId: "pol_bulk_chunk",
            effectiveFrom: "2026-07-01T00:00:00.000Z",
            effectiveUntil: null,
            resolvedAt: "2026-07-09T00:00:00.000Z",
          };
        }
        throw new Error(`Unexpected policy resolution in test: ${policy.policyKey}`);
      });

      let revision = "cts_before_revision";
      let openSessionCalls = 0;
      const revisableTermsResolver = {
        // Used by `createListing` while seeding the two listings below --
        // unrelated to the bulk path's revalidation behavior under test.
        resolveListingTerms: vi.fn(async ({ amount, accountId }: { amount: string; accountId: string }) => ({
          accountId,
          accountType: "business" as const,
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "1.00",
          sellerNetUnitAmount: "19.00",
          scheduleId: "cts_seed",
          agreementId: null,
          resolvedAt: "2026-07-09T00:00:00.000Z",
        })),
        openListingTermsSession: vi.fn(async ({ accountId }: { accountId: string }) => {
          openSessionCalls += 1;
          const scheduleId = revision;
          return {
            accountId,
            accountType: "business" as const,
            scheduleId,
            agreementId: null,
            resolvedAt: "2026-07-09T00:00:00.000Z",
            quote: (amount: string) => ({
              accountId,
              accountType: "business" as const,
              basisAmount: amount,
              marketplaceSalesFeeUnitAmount: "1.00",
              sellerNetUnitAmount: "19.00",
              scheduleId,
              agreementId: null,
              resolvedAt: "2026-07-09T00:00:00.000Z",
            }),
          };
        }),
      };

      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: bulkListingsDb() as never,
        commercialTermsResolver: revisableTermsResolver as never,
        policies: { resolvePolicy } as never,
      });

      const listingIds = ["lst_revision_1", "lst_revision_2"];
      for (const listingId of listingIds) {
        await services.createListing(
          {
            accountId: "acc_seller" as never,
            inventoryItemId: "inv_1",
            priceAmount: "20.00",
            priceCurrencyCode: "USD",
            quantityCap: 1,
            listingIdOverride: listingId as never,
          },
          context,
        );
      }

      const outcomes = await services.applyBulkListingPriceUpdates(
        {
          accountId: "acc_seller",
          updates: [
            { listingId: "lst_revision_1", priceAmount: "21.00", priceCurrencyCode: "USD" },
            { listingId: "lst_revision_2", priceAmount: "22.00", priceCurrencyCode: "USD" },
          ],
        },
        context,
      );

      expect(outcomes.every((outcome) => outcome.outcome === "applied")).toBe(true);
      expect(revisableTermsResolver.openListingTermsSession).toHaveBeenCalledTimes(1);

      const firstListingEvents = await eventStore.readStream({ streamId: "marketplace.listing-lst_revision_1" });
      const secondListingEvents = await eventStore.readStream({ streamId: "marketplace.listing-lst_revision_2" });
      const firstPriceUpdate = firstListingEvents.find(
        (event) => event.eventType === "marketplace.listing.price-updated",
      );
      const secondPriceUpdate = secondListingEvents.find(
        (event) => event.eventType === "marketplace.listing.price-updated",
      );

      expect((firstPriceUpdate?.payload as { termsScheduleId?: string })?.termsScheduleId).toBe("cts_seed");
      expect((secondPriceUpdate?.payload as { termsScheduleId?: string })?.termsScheduleId).toBe("cts_seed");
      expect((firstPriceUpdate?.payload as { feeQuoteFingerprint?: string })?.feeQuoteFingerprint).not.toBe(
        (secondPriceUpdate?.payload as { feeQuoteFingerprint?: string })?.feeQuoteFingerprint,
      );
    });

    it("returns an empty result and skips the lane entirely for an empty update batch", async () => {
      const { eventStore } = createInMemoryEventStore();
      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: bulkListingsDb() as never,
        commercialTermsResolver: bulkTermsResolver() as never,
      });

      await expect(
        services.applyBulkListingPriceUpdates({ accountId: "acc_seller", updates: [] }, context),
      ).resolves.toEqual([]);
    });
  });

  describe("listing evidence garbage collection", () => {
    function gcAsset(key: string) {
      return {
        role: "source",
        width: 1200,
        height: 1600,
        density: null,
        mediaType: "image/webp",
        storageKey: key,
        publicUrl: `https://assets.test/${key}`,
        byteSize: 100,
        generatedAt: "2026-05-09T00:00:00.000Z",
      };
    }
    function gcPhoto(photoId: string, status: string, sourceHash: string) {
      return {
        photoId,
        originalFilename: null,
        altText: null,
        slotId: null,
        viewKind: null,
        status,
        sortOrder: 0,
        capturedAt: null,
        uploadedAt: "2026-05-09T00:00:00.000Z",
        assetRevision: `rev-${sourceHash}`,
        replacesPhotoId: null,
        assetSet: { kind: "listing-photo", sourceHash, source: gcAsset(`${photoId}/source`), variants: [] },
      };
    }

    function gcDb(evidence: unknown[], updatedAt: string) {
      return {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("FROM marketplace_listing_pages") && sql.includes("COALESCE(entry->>'status', 'active')")) {
            return { rows: [{ listing_id: "lst_1", updated_at: updatedAt, evidence: evidence }] };
          }
          throw new Error(`Unexpected query in test: ${sql}`);
        }),
      };
    }

    it("deletes retired, unreferenced assets past the safe delay and is observable", async () => {
      const { eventStore } = createInMemoryEventStore();
      const deleted: string[][] = [];
      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: gcDb(
          [gcPhoto("lpho_active", "active", "hash_active"), gcPhoto("lpho_removed", "removed", "hash_removed")],
          "2026-01-01T00:00:00.000Z",
        ) as never,
        commercialTermsResolver: { resolveListingTerms: vi.fn() } as never,
        listingPhotoStorage: {
          getObject: vi.fn(),
          putObject: vi.fn(),
          deleteObjects: vi.fn(async (keys: readonly string[]) => {
            deleted.push([...keys]);
          }),
        },
      });

      const report = await services.collectListingEvidenceGarbage({ now: "2026-07-13T00:00:00.000Z" });

      expect(report.collectedPhotoIds).toEqual(["lpho_removed"]);
      expect(report.storageDeletionPerformed).toBe(true);
      expect(report.deletedAssetKeyCount).toBe(1);
      expect(deleted).toEqual([["lpho_removed/source"]]);
    });

    it("retains a retired asset whose source is still referenced by an active entry", async () => {
      const { eventStore } = createInMemoryEventStore();
      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: gcDb(
          [gcPhoto("lpho_active", "active", "shared"), gcPhoto("lpho_removed", "removed", "shared")],
          "2026-01-01T00:00:00.000Z",
        ) as never,
        commercialTermsResolver: { resolveListingTerms: vi.fn() } as never,
        listingPhotoStorage: { getObject: vi.fn(), putObject: vi.fn(), deleteObjects: vi.fn() },
      });

      const report = await services.collectListingEvidenceGarbage({ now: "2026-07-13T00:00:00.000Z" });
      expect(report.collectedPhotoIds).toEqual([]);
      expect(report.retainedReferencedPhotoIds).toEqual(["lpho_removed"]);
    });

    it("reports candidates but performs no deletion when storage cannot delete", async () => {
      const { eventStore } = createInMemoryEventStore();
      const services = createMarketplaceListingRuntime({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: gcDb([gcPhoto("lpho_removed", "removed", "hash_removed")], "2026-01-01T00:00:00.000Z") as never,
        commercialTermsResolver: { resolveListingTerms: vi.fn() } as never,
        listingPhotoStorage: { getObject: vi.fn(), putObject: vi.fn() },
      });

      const report = await services.collectListingEvidenceGarbage({ now: "2026-07-13T00:00:00.000Z" });
      expect(report.collectedPhotoIds).toEqual(["lpho_removed"]);
      expect(report.storageDeletionPerformed).toBe(false);
      expect(report.deletedAssetKeyCount).toBe(0);
    });
  });
});

describe("inventory capacity recovery", () => {
  function fixture(quantity = 6) {
    const memory = createInMemoryEventStore();
    let available = quantity;
    let publication: "ready" | "unavailable" | "missing-evidence" = "ready";
    let beforeAppend: (() => Promise<void>) | undefined;
    const eventStore: EventStore = {
      ...memory.eventStore,
      appendToStreams: async (inputs) => {
        const callback = beforeAppend;
        if (callback && inputs.some((i) => i.events.some((e) => e.eventType === "marketplace.listing.published"))) {
          beforeAppend = undefined;
          await callback();
        }
        return memory.eventStore.appendToStreams!(inputs);
      },
    };
    const services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("FROM marketplace_supply_items AS item"))
            return {
              rows: [
                {
                  item_id: "inv_shared",
                  account_id: "acc_seller",
                  catalog_catalog_item_id: "cat_1",
                  product_id: "cat_1::",
                  item_title: "Test Card",
                  selected_options: [],
                  product_measure_snapshot: productMeasureSnapshot,
                  storage_location_name: "Main",
                  ship_from_code: "CHI",
                  ship_from_address: shipFromAddress,
                  available_quantity: available,
                },
              ],
            };
          return { rows: [] };
        }),
      } as never,
      listingEvidencePolicyEvaluator: {
        evaluate: async (facts) => {
          if (publication === "unavailable") throw new Error("unavailable");
          const evaluation = evaluateListingEvidencePolicy(LISTING_EVIDENCE_LAUNCH_POLICY_VALUE, facts, {
            policyId: null,
            policyVersion: null,
            effectiveFrom: null,
            effectiveUntil: null,
          });
          return publication === "missing-evidence"
            ? { ...evaluation, requirements: { ...evaluation.requirements, minimumPhotoCount: 1 } }
            : evaluation;
        },
      },
      commercialTermsResolver: {
        resolveListingTerms: async ({ amount, accountId }: { amount: string; accountId: string }) => ({
          accountId,
          accountType: "business",
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "0.50",
          sellerNetUnitAmount: "9.50",
          scheduleId: "cts_test",
          agreementId: null,
          resolvedAt: "2026-10-28T00:00:00.000Z",
        }),
      } as never,
    });
    return {
      ...memory,
      services,
      setAvailable: (value: number) => {
        available = value;
      },
      setPublication: (value: typeof publication) => {
        publication = value;
      },
      race: (callback: () => Promise<void>) => {
        beforeAppend = callback;
      },
      reconcile: () => services.reconcileInventoryCapacity("inv_shared"),
      create: async (listingId: string, quantityCap = 1) => {
        await services.createListing(
          {
            accountId: "acc_seller" as never,
            inventoryItemId: "inv_shared",
            priceAmount: "10.00",
            priceCurrencyCode: "USD",
            quantityCap,
            listingIdOverride: listingId as never,
          },
          context,
        );
        await services.publishListing({ accountId: "acc_seller", listingId }, context);
      },
    };
  }

  it("includes every recovery candidate beyond the first seller-listings page", async () => {
    const f = fixture(51);
    for (let i = 0; i < 51; i += 1) await f.create(`lst_page_${String(i).padStart(3, "0")}`);
    f.setAvailable(0);
    await f.reconcile();
    f.setAvailable(51);
    await f.reconcile();
    expect((await f.services.loadListingState("lst_page_050")).status).toBe("active");
    expect(f.allEvents.filter((event) => event.eventType === "marketplace.listing.published")).toHaveLength(102);
  });

  it("never activates a moderated Listing or a channel-only Listing", async () => {
    const f = fixture(2);
    await f.create("lst_moderated");
    await f.services.operatorUnlistListing(
      {
        listingId: "lst_moderated" as never,
        sourceActionId: createId("rca"),
        listingEnforcementActionId: createId("lea"),
        recordedAt: new Date().toISOString(),
      },
      context,
    );
    await f.services.createListing(
      {
        accountId: "acc_seller" as never,
        inventoryItemId: "inv_shared",
        priceAmount: "10.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        listingIdOverride: "lst_channel_only" as never,
        publicationScope: "channel-only",
      },
      context,
    );
    const count = f.allEvents.length;
    await f.reconcile();
    expect(f.allEvents).toHaveLength(count);
    expect((await f.services.loadListingState("lst_moderated")).status).toBe("paused");
    expect((await f.services.loadListingState("lst_channel_only")).status).toBe("draft");
  });

  it.each(["unavailable", "missing-evidence"] as const)(
    "persists an actionable %s gate condition, stays inert, and clears it on recovery",
    async (gate) => {
      const f = fixture(1);
      await f.create("lst_blocked");
      f.setAvailable(0);
      await f.reconcile();
      f.setAvailable(1);
      f.setPublication(gate);
      await f.reconcile();
      const expectedBlock = gate === "unavailable" ? "publication-unavailable" : "evidence-incomplete";
      expect(await f.services.loadListingState("lst_blocked")).toMatchObject({
        status: "paused",
        pauseReason: "inventory-capacity",
        inventoryCapacityRecoveryBlock: expectedBlock,
      });
      const blockedCount = f.allEvents.length;
      await f.reconcile();
      expect(f.allEvents).toHaveLength(blockedCount);
      const replayed = (await f.eventStore.readStream({ streamId: "marketplace.listing-lst_blocked" })).reduce(
        (state, event) =>
          evolveMarketplaceListing(state, { type: event.eventType, data: event.payload } as MarketplaceListingEvent),
        initialMarketplaceListingState,
      );
      expect(replayed.inventoryCapacityRecoveryBlock).toBe(expectedBlock);
      f.setPublication("ready");
      await f.reconcile();
      expect(await f.services.loadListingState("lst_blocked")).toMatchObject({
        status: "active",
        inventoryCapacityRecoveryBlock: null,
      });
    },
  );

  it("allocates fitting candidates after active commitments in registry order and ignores stale empty Listing projections", async () => {
    const f = fixture(6);
    await f.create("lst_a_active", 1);
    await f.create("lst_b_large", 3);
    await f.create("lst_c_small", 1);
    await f.create("lst_z_small", 1);
    f.setAvailable(3);
    await f.reconcile();
    expect((await f.services.loadListingState("lst_a_active")).status).toBe("active");
    f.setAvailable(2);
    await Promise.all([f.reconcile(), f.reconcile()]);
    const states = await Promise.all(
      ["lst_a_active", "lst_b_large", "lst_c_small", "lst_z_small"].map((id) => f.services.loadListingState(id)),
    );
    expect(states.map((s) => s.status)).toEqual(["active", "paused", "active", "paused"]);
    expect(states.filter((s) => s.status === "active").reduce((sum, s) => sum + s.quantityCap, 0)).toBe(2);
    const settled = f.allEvents.length;
    await f.reconcile();
    expect(f.allEvents).toHaveLength(settled);
  });

  it.each(["pause", "withdraw"] as const)(
    "does not override a seller %s racing the protected recovery append",
    async (action) => {
      const f = fixture(1);
      await f.create("lst_race");
      f.setAvailable(0);
      await f.reconcile();
      f.setAvailable(1);
      f.race(async () => {
        const params = { accountId: "acc_seller", listingId: "lst_race" };
        if (action === "pause") await f.services.pauseListing(params, context);
        else await f.services.withdrawListing(params, context);
      });
      await f.reconcile();
      expect(await f.services.loadListingState("lst_race")).toMatchObject({
        status: action === "pause" ? "paused" : "withdrawn",
        pauseReason: action === "pause" ? "seller" : null,
      });
      expect(f.allEvents.filter((e) => e.eventType === "marketplace.listing.published")).toHaveLength(1);
    },
  );

  it("recovers a seller-edited capacity-paused Listing on the fresh revision", async () => {
    const f = fixture(1);
    await f.create("lst_revision");
    f.setAvailable(0);
    await f.reconcile();
    f.setAvailable(1);
    f.race(async () => {
      await f.services.updateListingPurchaseLimits(
        { accountId: "acc_seller", listingId: "lst_revision", purchaseLimits: { maxUnitsPerOrder: 1 } },
        context,
      );
    });
    await f.reconcile();
    expect(await f.services.loadListingState("lst_revision")).toMatchObject({
      status: "active",
      purchaseLimits: { maxUnitsPerOrder: 1 },
    });
    expect(f.allEvents.filter((e) => e.eventType === "marketplace.listing.published")).toHaveLength(2);
  });

  it.each(["seller", "channel-inbound-dark", "policy-input-missing"] as const)(
    "never recovers a %s pause",
    async (reason) => {
      const f = fixture(1);
      await f.create("lst_excluded");
      await f.services.commandHandler({
        streamId: "marketplace.listing-lst_excluded",
        command: { type: "PauseListing", reason },
        context,
      });
      const count = f.allEvents.length;
      await f.reconcile();
      expect(f.allEvents).toHaveLength(count);
      expect(await f.services.loadListingState("lst_excluded")).toMatchObject({
        status: "paused",
        pauseReason: reason,
      });
    },
  );

  it("keeps seller Away effective and records an actionable condition until current authority allows recovery", async () => {
    const f = fixture(1);
    await f.create("lst_away");
    f.setAvailable(0);
    await f.reconcile();
    f.setAvailable(1);
    await f.services.disableSellerListingAvailability(
      { accountId: "acc_seller", reasonCategory: "travel", availableAgainOn: null },
      context,
    );
    await f.reconcile();
    expect(await f.services.loadListingState("lst_away")).toMatchObject({
      status: "paused",
      inventoryCapacityRecoveryBlock: "seller-away",
    });
    await f.services.enableSellerListingAvailability({ accountId: "acc_seller" }, context);
    await f.reconcile();
    expect((await f.services.loadListingState("lst_away")).status).toBe("active");
  });

  it("records a system capacity pause for a held quantity-one Listing and restores it after release", async () => {
    const { allEvents, eventStore } = createInMemoryEventStore();
    let availableQuantity = 1;
    let services: ReturnType<typeof createMarketplaceListingRuntime>;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM marketplace_supply_items AS item")) {
          return {
            rows: [
              {
                item_id: "inv_capacity",
                account_id: "acc_seller",
                catalog_catalog_item_id: "cat_1",
                product_id: "cat_1::",
                item_title: "Charizard",
                selected_options: [],
                product_measure_snapshot: productMeasureSnapshot,
                storage_location_name: "North shelf",
                ship_from_code: "CHI",
                ship_from_address: shipFromAddress,
                available_quantity: availableQuantity,
              },
            ],
          };
        }
        if (sql.includes("FROM marketplace_listing_pages")) {
          const state = await services.loadListingState("lst_capacity");
          return {
            rows:
              state.status === "active"
                ? [
                    {
                      listing_id: state.listingId,
                      account_id: state.accountId,
                      quantity_cap: state.quantityCap,
                    },
                  ]
                : [],
          };
        }
        return { rows: [] };
      }),
    };
    services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      commercialTermsResolver: {
        resolveListingTerms: async ({ amount, accountId }: { amount: string; accountId: string }) => ({
          accountId,
          accountType: "business",
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "1.00",
          sellerNetUnitAmount: "19.00",
          scheduleId: "cts_default",
          agreementId: null,
          resolvedAt: "2026-04-17T00:00:00.000Z",
        }),
      } as never,
    });
    await services.createListing(
      {
        accountId: "acc_seller" as never,
        inventoryItemId: "inv_capacity",
        priceAmount: "20.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        listingIdOverride: "lst_capacity" as never,
      },
      context,
    );
    await services.publishListing({ accountId: "acc_seller", listingId: "lst_capacity" }, context);
    const original = await services.loadListingState("lst_capacity");
    availableQuantity = 0;
    await services.reconcileInventoryCapacity("inv_capacity");
    expect(await services.loadListingState("lst_capacity")).toMatchObject({
      status: "paused",
      pauseReason: "inventory-capacity",
    });
    expect(allEvents.find((event) => event.eventType === "marketplace.listing.paused")).toMatchObject({
      performedByUserId: "usr_marketplace_system",
    });
    availableQuantity = 1;
    await services.reconcileInventoryCapacity("inv_capacity");
    expect(await services.loadListingState("lst_capacity")).toMatchObject({
      status: "active",
      pauseReason: null,
      feeLocks: original.feeLocks,
      quantityCap: 1,
      priceAmount: "20.00",
    });
    const recoveredCount = allEvents.length;
    await services.reconcileInventoryCapacity("inv_capacity");
    expect(allEvents).toHaveLength(recoveredCount);
  });
});

describe("issue-5258-marketplace-ac2 Listing Evidence description pre-check", () => {
  function createFixture() {
    const { allEvents, eventStore } = createInMemoryEventStore();
    const putObject = vi.fn();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM marketplace_supply_items AS item")) {
          return {
            rows: [
              {
                item_id: "inv_1",
                account_id: "acc_seller",
                catalog_catalog_item_id: "cat_1",
                product_id: "cat_1::",
                item_title: "Charizard",
                item_subtitle: null,
                selected_options: [],
                product_summary: null,
                product_measure_snapshot: productMeasureSnapshot,
                storage_location_name: "North shelf",
                ship_from_code: "CHI",
                ship_from_address: shipFromAddress,
                available_quantity: 2,
              },
            ],
          };
        }
        if (sql.includes("COALESCE(SUM(quantity_cap), 0)::text AS quantity_cap")) {
          return { rows: [{ quantity_cap: "0" }] };
        }
        throw new Error(`Unexpected query in test: ${sql}`);
      }),
    };
    const services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      commercialTermsResolver: {
        resolveListingTerms: vi.fn(async ({ amount, accountId }) => ({
          accountId,
          accountType: "business" as const,
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "1.00",
          sellerNetUnitAmount: "19.00",
          scheduleId: "cts_default",
          agreementId: null,
          resolvedAt: "2026-04-17T00:00:00.000Z",
        })),
      } as never,
      listingPhotoStorage: { getObject: vi.fn(), putObject },
    });
    const createParams = {
      accountId: "acc_seller" as never,
      inventoryItemId: "inv_1",
      priceAmount: "20.00",
      priceCurrencyCode: "USD",
      quantityCap: 1,
      listingIdOverride: "lst_alt" as never,
    };
    return { allEvents, putObject, services, createParams };
  }

  const upload = (altText: string) => ({
    body: new Uint8Array([1, 2, 3]),
    contentType: "image/png",
    originalFilename: "front.png",
    altText,
  });

  it("rejects an unsafe description before image work, storing and appending nothing", async () => {
    const { allEvents, putObject, services, createParams } = createFixture();

    await expect(
      services.createListing({ ...createParams, listingPhotoUploads: [upload("Front javascript:alert(1)")] }, context),
    ).rejects.toMatchObject({ name: "AuthoredTextRejectedError", code: "text_unsafe_link" });
    expect(putObject).not.toHaveBeenCalled();
    expect(allEvents).toHaveLength(0);
  });

  it("rejects an unsafe replacement description before image work", async () => {
    const { allEvents, putObject, services, createParams } = createFixture();
    await services.createListing(createParams, context);
    await services.commandHandler({
      streamId: "marketplace.listing-lst_alt",
      command: { type: "AddListingPhotos", photos: [listingPhoto] as never },
      context,
    });
    const eventCount = allEvents.length;

    await expect(
      services.replaceListingPhoto(
        { accountId: "acc_seller", listingId: "lst_alt", replacedPhotoId: "lpho_1", upload: upload("Back \u0000") },
        context,
      ),
    ).rejects.toMatchObject({ name: "AuthoredTextRejectedError", code: "text_control_character" });
    expect(putObject).not.toHaveBeenCalled();
    expect(allEvents).toHaveLength(eventCount);
  });
});

describe("inventory capacity recovery revision races", () => {
  function probeFixture(quantity: number) {
    const memory = createInMemoryEventStore();
    let available = quantity;
    let hook: { eventType: string; run: () => Promise<void> } | undefined;
    const eventStore: EventStore = {
      ...memory.eventStore,
      appendToStreams: async (inputs) => {
        const current = hook;
        if (current && inputs.some((i) => i.events.some((e) => e.eventType === current.eventType))) {
          hook = undefined;
          await current.run();
        }
        return memory.eventStore.appendToStreams!(inputs);
      },
    };
    const services = createMarketplaceListingRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("FROM marketplace_supply_items AS item"))
            return {
              rows: [
                {
                  item_id: "inv_probe",
                  account_id: "acc_seller",
                  catalog_catalog_item_id: "cat_1",
                  product_id: "cat_1::",
                  item_title: "Probe Card",
                  selected_options: [],
                  product_measure_snapshot: productMeasureSnapshot,
                  storage_location_name: "Main",
                  ship_from_code: "CHI",
                  ship_from_address: shipFromAddress,
                  available_quantity: available,
                },
              ],
            };
          return { rows: [] };
        }),
      } as never,
      listingEvidencePolicyEvaluator: {
        evaluate: async (facts) =>
          evaluateListingEvidencePolicy(LISTING_EVIDENCE_LAUNCH_POLICY_VALUE, facts, {
            policyId: null,
            policyVersion: null,
            effectiveFrom: null,
            effectiveUntil: null,
          }),
      },
      commercialTermsResolver: {
        resolveListingTerms: async ({ amount, accountId }: { amount: string; accountId: string }) => ({
          accountId,
          accountType: "business",
          basisAmount: amount,
          marketplaceSalesFeeUnitAmount: "0.50",
          sellerNetUnitAmount: "9.50",
          scheduleId: "cts_test",
          agreementId: null,
          resolvedAt: "2026-10-28T00:00:00.000Z",
        }),
      } as never,
    });
    const create = async (listingId: string) => {
      await services.createListing(
        {
          accountId: "acc_seller" as never,
          inventoryItemId: "inv_probe",
          priceAmount: "10.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
          listingIdOverride: listingId as never,
        },
        context,
      );
      await services.publishListing({ accountId: "acc_seller", listingId }, context);
    };
    const sellerEdit = (listingId: string) =>
      services.updateListingPurchaseLimits(
        { accountId: "acc_seller", listingId, purchaseLimits: { maxUnitsPerOrder: 1 } },
        context,
      );
    return {
      services,
      create,
      sellerEdit,
      setAvailable: (value: number) => {
        available = value;
      },
      on: (eventType: string, run: () => Promise<void>) => {
        hook = { eventType, run };
      },
      activeTotal: async (ids: readonly string[]) =>
        (await Promise.all(ids.map((id) => services.loadListingState(id))))
          .filter((s) => s.status === "active")
          .reduce((sum, s) => sum + s.quantityCap, 0),
    };
  }

  it("PROBE-F1: a seller edit racing a shortage pause must not leave active caps above available", async () => {
    const f = probeFixture(2);
    await f.create("lst_probe_a");
    await f.create("lst_probe_b");
    f.setAvailable(1);
    // Reverse registry order pauses lst_probe_b first; the seller edits it just before that append.
    f.on("marketplace.listing.paused", () => f.sellerEdit("lst_probe_b").then(() => undefined));
    await f.services.reconcileInventoryCapacity("inv_probe");
    expect(await f.activeTotal(["lst_probe_a", "lst_probe_b"])).toBeLessThanOrEqual(1);
  });

  it("PROBE-F2: a seller edit racing recovery must not strand an unblocked capacity pause with capacity available", async () => {
    const f = probeFixture(1);
    await f.create("lst_probe_r");
    f.setAvailable(0);
    await f.services.reconcileInventoryCapacity("inv_probe");
    f.setAvailable(1);
    f.on("marketplace.listing.published", () => f.sellerEdit("lst_probe_r").then(() => undefined));
    // The release callback runs exactly once; no further Inventory event follows in this scenario.
    await f.services.reconcileInventoryCapacity("inv_probe");
    const state = await f.services.loadListingState("lst_probe_r");
    expect({ status: state.status, block: state.inventoryCapacityRecoveryBlock }).not.toEqual({
      status: "paused",
      block: null,
    });
  });
});
