import { describe, expect, it, vi } from "vitest";
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

function createInMemoryEventStore() {
  let globalPosition = 0;
  const streams = new Map<string, StoredEvent[]>();
  const allEvents: StoredEvent[] = [];

  function appendStoredEvents(input: AppendToStreamInput): StoredEvent[] {
    const existing = streams.get(input.streamId) ?? [];
    const stored = input.events.map((event, index) => {
      globalPosition += 1;
      return {
        eventId: `evt_${globalPosition}` as never,
        streamId: input.streamId,
        streamVersion: existing.length + index + 1,
        globalPosition: String(globalPosition) as GlobalPosition,
        tenantId: input.context.tenantId,
        eventType: event.eventType,
        payload: event.payload,
        metadata: event.metadata ?? {},
        occurredAt: new Date().toISOString() as never,
        recordedAt: new Date().toISOString() as never,
        performedByUserId: input.context.audit.performedByUserId,
        forAccountId: input.context.audit.forAccountId,
        traceId: input.context.trace?.traceId,
        spanId: input.context.trace?.spanId,
        parentSpanId: input.context.trace?.parentSpanId,
        traceState: input.context.trace?.traceState,
      } satisfies StoredEvent;
    });

    streams.set(input.streamId, [...existing, ...stored]);
    allEvents.push(...stored);
    return stored;
  }

  function currentVersionMatches(input: AppendToStreamInput): boolean {
    const currentVersion = (streams.get(input.streamId) ?? []).length;
    if (input.expectedVersion === "any") {
      return true;
    }
    if (input.expectedVersion === "no_stream") {
      return currentVersion === 0;
    }
    return input.expectedVersion === currentVersion;
  }

  const eventStore: EventStore = {
    appendToStream: async (input: AppendToStreamInput) => appendStoredEvents(input),
    // A simplified but version-faithful independent-append fake: per-stream
    // conflicts are isolated (never abort a sibling's append) -- the same
    // invariant `appendToStreamsIndependently` guarantees against real
    // Postgres (see event-core-postgres/event-store.db.test.ts).
    appendToStreamsIndependently: async (inputs) => {
      const results: AppendToStreamsIndependentResult[] = [];
      for (const input of inputs) {
        if (input.events.length === 0) {
          results.push({ streamId: input.streamId, outcome: "no_op", storedEvents: [] });
          continue;
        }
        if (!currentVersionMatches(input)) {
          results.push({
            streamId: input.streamId,
            outcome: "conflict",
            storedEvents: [],
            error: Object.assign(new Error("Expected stream version does not match current version."), {
              code: "concurrency_conflict",
            }) as never,
          });
          continue;
        }
        results.push({ streamId: input.streamId, outcome: "appended", storedEvents: appendStoredEvents(input) });
      }
      return results;
    },
    readStream: async (input: ReadStreamInput) =>
      [...(streams.get(input.streamId) ?? [])].slice(input.fromVersion ?? 0),
    readAll: async (input?: ReadAllInput) => {
      const after = Number(input?.afterGlobalPosition ?? ZERO_GLOBAL_POSITION);
      return allEvents.filter((event) => Number(event.globalPosition) > after);
    },
  };

  return { eventStore };
}

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
                row.quantity_cap === params[5] &&
                row.max_units_per_order === params[6] &&
                row.max_units_per_day === params[7] &&
                row.max_units_per_customer_account === params[8],
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
          quantity_cap: Number(params[8]),
          max_units_per_order: params[9] === null ? null : Number(params[9]),
          max_units_per_day: params[10] === null ? null : Number(params[10]),
          max_units_per_customer_account: params[11] === null ? null : Number(params[11]),
          status: "active",
          claimed_account_id: null,
          claimed_at: null,
          expires_at: String(params[12]),
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
        quantityCap: 1,
        listingIdOverride: "lst_seed_1" as never,
      },
      context,
    );

    const preview = await services.previewListingTerms({
      accountId: "acc_seller",
      priceAmount: "20.00",
    });

    await expect(
      services.publishListing(
        {
          accountId: "acc_seller",
          listingId: "lst_seed_1",
          feeQuoteFingerprint: preview.fee_quote_fingerprint,
        },
        context,
      ),
    ).resolves.toEqual({
      listingId: "lst_seed_1",
      version: 2,
    });
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
        event_type: "marketplace.listing.published",
        stream_version: 2,
        marketplace_sales_fee_unit_amount: "1.00",
        seller_net_unit_amount: "19.00",
        terms_schedule_id: "cts_default",
        performed_by_user_id: "usr_seller",
      },
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

  it("blocks high-dollar publication for accounts without listing evidence", async () => {
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
    ).rejects.toThrow("High-dollar listings require at least one listing photo before publication.");
  });

  it("blocks high-dollar publication for untrusted accounts even with listing evidence", async () => {
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
    ).rejects.toThrow(
      "High-dollar listings require a trusted seller account or established account reputation before publication.",
    );
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
          event_type: "marketplace.listing.published",
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
          quantityCap: 2,
        },
        context,
      ),
    ).rejects.toThrow("Listing quantity caps cannot exceed available listing stock.");
  });

  it("blocks high-dollar publication using a revised (lower) listing-gate policy threshold from the injected platform-policy runtime", async () => {
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
    const resolvePolicy = vi.fn(async () => ({
      policyKey: "marketplace.listing-gate",
      value: {
        highDollarListingAmount: "50.00",
        minTrustedReputationReviews: 3,
        maxActiveAnonymousListingDrafts: 20,
        anonymousListingDraftTtlDays: 30,
        maxListingPhotoUploadBytes: 10 * 1024 * 1024,
      },
      source: "policy" as const,
      documentId: "pol_listing_gate",
      effectiveFrom: "2026-04-01T00:00:00.000Z",
      effectiveUntil: null,
      resolvedAt: "2026-04-17T00:00:00.000Z",
    }));
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
      policies: { resolvePolicy } as never,
    });

    // $100 is below the compiled $250 default but at/above the revised $50 threshold.
    const created = await services.createListing(
      {
        accountId: "acc_seller" as never,
        inventoryItemId: "inv_1",
        priceAmount: "100.00",
        quantityCap: 1,
        listingIdOverride: "lst_revised_threshold" as never,
      },
      context,
    );

    await expect(
      services.publishListing(
        {
          accountId: "acc_seller",
          listingId: "lst_revised_threshold",
          feeQuoteFingerprint: created.feeQuoteFingerprint,
        },
        context,
      ),
    ).rejects.toThrow("High-dollar listings require at least one listing photo before publication.");
    expect(resolvePolicy).toHaveBeenCalledWith(expect.objectContaining({ policyKey: "marketplace.listing-gate" }));
  });

  it("allows a $100 listing to publish under the compiled default listing-gate threshold when no policies runtime is wired", async () => {
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
        highDollarListingAmount: "250.00",
        minTrustedReputationReviews: 3,
        maxActiveAnonymousListingDrafts: 1,
        anonymousListingDraftTtlDays: 30,
        maxListingPhotoUploadBytes: 10 * 1024 * 1024,
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
        quantityCap: 1,
      }),
    ).rejects.toThrow(
      "Too many saved listing drafts. Review or finish registration before saving another listing draft.",
    );
    expect(resolvePolicy).toHaveBeenCalledWith(expect.objectContaining({ policyKey: "marketplace.listing-gate" }));
  });

  describe("applyBulkListingPriceUpdates (#4326 chunked multi-listing appends)", () => {
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
      };
    }

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
            { listingId: "lst_bulk_1", priceAmount: "25.00", feeQuoteFingerprint: changedQuote.fee_quote_fingerprint },
            { listingId: "lst_bulk_2", priceAmount: "20.00", feeQuoteFingerprint: sameQuote.fee_quote_fingerprint },
            {
              listingId: "lst_bulk_3",
              priceAmount: "30.00",
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
          quantityCap: 1,
          listingIdOverride: "lst_owned" as never,
        },
        context,
      );

      const outcomes = await services.applyBulkListingPriceUpdates(
        {
          accountId: "acc_seller",
          updates: [
            { listingId: "lst_does_not_exist", priceAmount: "25.00", feeQuoteFingerprint: "stale" },
            { listingId: "lst_owned", priceAmount: "25.00", feeQuoteFingerprint: "stale-too" },
          ],
        },
        context,
      );

      expect(outcomes[0]).toMatchObject({ listingId: "lst_does_not_exist", outcome: "error" });
      expect(outcomes[1]).toMatchObject({ listingId: "lst_owned", outcome: "error" });
      // Both fail at the fee-quote preflight stage in this test (stale fingerprints), independently.
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
});
