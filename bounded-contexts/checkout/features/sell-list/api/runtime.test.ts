import { buildSellListReviewPlan, readinessDecisionsFromReviewPlan } from "./review-plan";
import type { CheckoutSellOfferMatch } from "../read-model/queries";
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { buildTransportEvent, createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createSellListReadinessSnapshot, parseSellListReadinessDecisionInput } from "../domain/readiness";
import type { SellListSellerConfirmationEvidence } from "../domain/domain";
import { listSellListReadinessLines, type CheckoutSellListLineRow } from "../read-model/queries";
import { createCheckoutSellListRuntime } from "./runtime";
import { buildCheckoutMarketplaceSellerOptionsProjectionHandlers } from "../../cart/integrations/marketplace/marketplace-projection";
import * as checkoutRequest from "../../../support/request-support/api-client";
import * as marketplaceRequest from "@chase-sets/marketplace/server";
import * as auth from "@chase-sets/platform-runtime/auth";
import * as postWrite from "@chase-sets/platform-runtime/post-write-tokens";
import { action as sellCheckoutAction } from "../../../support/route-support/sell-checkout-session/sell-checkout-action";
import { parseSellerCheckoutChoices } from "../read-model/seller-checkout-owner-reads";
import {
  checkoutOwnerRuntimeFixture,
  choices,
  fixtureLine,
  ownedAbsentRisk,
  ownerPortsFixture,
  marketplaceHandoffFixture,
  prepareSellerConfirmation,
  stamp,
} from "./owner-read.fixture";

/**
 * Seed row for the marketplace evidence read-model the confirm path consults.
 * Empty requirements resolve to complete coverage, so the exact Listing a
 * selected-offer line commits to reads as evidence-ready in both the
 * client-issued snapshot and the server-side revalidation.
 */
const readyListingEvidenceRow = {
  listing_id: "lst_ready",
  status: "active",
  evidence_requirements: {
    policyHash: "ph_seed",
    policyVersion: 1,
    requirements: { requiredSlots: [], minimumPhotoCount: 0, sellerTrustRequirements: [] },
  },
  evidence: [] as unknown[],
  updated_at: "2026-06-09T00:00:00.000Z",
};

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_seller" as never,
    forAccountId: "acc_seller" as never,
  },
};

const selectedOfferLine: CheckoutSellListLineRow = {
  seller_account_id: "acc_seller",
  line_id: "sll_offer",
  line_type: "selected-offer",
  offer_id: "off_ready",
  listing_id: "lst_ready",
  buyer_account_id: "acc_buyer",
  buyer_display_name: "Jane Buyer",
  offer_price_amount: "120.00",
  offer_price_currency_code: "USD",
  offer_stream_version: 3,
  listing_price_amount: "125.00",
  listing_price_currency_code: "USD",
  listing_stream_version: 7,
  catalog_catalog_item_id: "cat_1",
  product_id: "cat_1::form:raw",
  item_title: "Charizard",
  item_subtitle: null,
  selected_options: [],
  product_summary: "Raw",
  quantity: 1,
  fallback_mode: "none",
  minimum_listing_price_amount: null,
  created_at: "2026-06-09T00:00:00.000Z",
  updated_at: "2026-06-09T00:00:00.000Z",
};

const productLine: CheckoutSellListLineRow = {
  seller_account_id: "acc_seller",
  line_id: "sll_product",
  line_type: "product",
  offer_id: null,
  listing_id: null,
  buyer_account_id: null,
  buyer_display_name: null,
  offer_price_amount: null,
  offer_price_currency_code: null,
  offer_stream_version: null,
  listing_price_amount: null,
  listing_price_currency_code: null,
  listing_stream_version: null,
  catalog_catalog_item_id: "cat_2",
  product_id: "cat_2::form:raw",
  item_title: "Blastoise",
  item_subtitle: null,
  selected_options: [],
  product_summary: "Raw",
  quantity: 1,
  fallback_mode: "none",
  minimum_listing_price_amount: null,
  created_at: "2026-06-09T00:00:00.000Z",
  updated_at: "2026-06-09T00:00:00.000Z",
};

type CatalogItemRow = Readonly<{
  catalog_item_id: string;
  status: string;
  product_schema: unknown;
}>;

const airBalloonProductId =
  "cat_air_balloon::dim_seed_form:chc_seed_form_raw|dim_seed_condition:chc_seed_condition_damaged|dim_seed_grading_company:-|dim_seed_grade:-";

const airBalloonProductSchema = {
  canonicalDimensionOrder: [
    { dimensionId: "dim_seed_form", dimensionName: "Form" },
    { dimensionId: "dim_seed_condition", dimensionName: "Condition" },
    { dimensionId: "dim_seed_grading_company", dimensionName: "Grading Company" },
    { dimensionId: "dim_seed_grade", dimensionName: "Grade" },
  ],
  dimensions: [
    {
      dimensionId: "dim_seed_form",
      dimensionName: "Form",
      required: true,
      appliesWhen: [],
      allowedOptions: [{ optionId: "chc_seed_form_raw", code: "raw", label: "Raw" }],
    },
    {
      dimensionId: "dim_seed_condition",
      dimensionName: "Condition",
      required: true,
      appliesWhen: [],
      allowedOptions: [{ optionId: "chc_seed_condition_damaged", code: "damaged", label: "Damaged" }],
    },
    {
      dimensionId: "dim_seed_grading_company",
      dimensionName: "Grading Company",
      required: false,
      appliesWhen: [],
      allowedOptions: [],
    },
    {
      dimensionId: "dim_seed_grade",
      dimensionName: "Grade",
      required: false,
      appliesWhen: [],
      allowedOptions: [],
    },
  ],
};

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) => checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, checkpoint) => {
      checkpoints.set(projectorName, checkpoint);
    },
  };
}

function projectedSelectedOptions(value: unknown): CheckoutSellListLineRow["selected_options"] {
  if (Array.isArray(value)) {
    return value as CheckoutSellListLineRow["selected_options"];
  }
  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as CheckoutSellListLineRow["selected_options"]) : [];
  } catch {
    return [];
  }
}

function createDb(lines: readonly CheckoutSellListLineRow[], catalogItems: readonly CatalogItemRow[] = []) {
  let sellListLines = [...lines];
  const catalogItemsById = new Map(catalogItems.map((item) => [item.catalog_item_id, item]));
  const db = {
    query: vi.fn(async (query: unknown, params?: readonly unknown[]) => {
      const sql = String(query);
      if (sql.includes("FROM checkout_catalog_items")) {
        const catalogItemId = String(params?.[0] ?? "");
        const item = catalogItemsById.get(catalogItemId);
        return { rows: item ? [item] : [] };
      }
      if (sql.includes("checkout_sell_list_confirmation_pages")) {
        return { rows: [] };
      }
      if (sql.includes("checkout_marketplace_seller_options")) {
        const listingId = String(params?.[0] ?? "");
        return { rows: listingId === readyListingEvidenceRow.listing_id ? [readyListingEvidenceRow] : [] };
      }
      if (sql.includes("checkout_sell_list_line_pages")) {
        if (/INSERT\s+INTO\s+checkout_sell_list_line_pages/i.test(sql)) {
          const row: CheckoutSellListLineRow = {
            seller_account_id: String(params?.[0] ?? ""),
            line_id: String(params?.[1] ?? ""),
            line_type: params?.[2] === "selected-offer" ? "selected-offer" : "product",
            offer_id: params?.[3] === null || params?.[3] === undefined ? null : String(params[3]),
            listing_id: params?.[4] === null || params?.[4] === undefined ? null : String(params[4]),
            buyer_account_id: params?.[5] === null || params?.[5] === undefined ? null : String(params[5]),
            buyer_display_name: params?.[6] === null || params?.[6] === undefined ? null : String(params[6]),
            offer_price_amount: params?.[7] === null || params?.[7] === undefined ? null : String(params[7]),
            offer_price_currency_code: params?.[8] === null || params?.[8] === undefined ? null : String(params[8]),
            offer_stream_version: params?.[9] === null || params?.[9] === undefined ? null : Number(params[9]),
            listing_price_amount: params?.[10] === null || params?.[10] === undefined ? null : String(params[10]),
            listing_price_currency_code:
              params?.[11] === null || params?.[11] === undefined ? null : String(params[11]),
            listing_stream_version: params?.[12] === null || params?.[12] === undefined ? null : Number(params[12]),
            catalog_catalog_item_id: String(params?.[13] ?? ""),
            product_id: String(params?.[14] ?? ""),
            item_title: String(params?.[15] ?? ""),
            item_subtitle: params?.[16] === null || params?.[16] === undefined ? null : String(params[16]),
            selected_options: projectedSelectedOptions(params?.[17]),
            product_summary: params?.[18] === null || params?.[18] === undefined ? null : String(params[18]),
            quantity: Number(params?.[19] ?? 0),
            fallback_mode: params?.[20] === "create-listing" ? "create-listing" : "none",
            minimum_listing_price_amount:
              params?.[21] === null || params?.[21] === undefined ? null : String(params[21]),
            created_at: String(params?.[22] ?? ""),
            updated_at: String(params?.[22] ?? ""),
          };
          const existingIndex = sellListLines.findIndex(
            (line) => line.seller_account_id === row.seller_account_id && line.line_id === row.line_id,
          );
          sellListLines =
            existingIndex >= 0
              ? sellListLines.map((line, index) => (index === existingIndex ? row : line))
              : [...sellListLines, row];
          return { rows: [] };
        }

        if (sql.includes("UPDATE checkout_sell_list_line_pages") && sql.includes("SET quantity")) {
          const sellerAccountId = String(params?.[0] ?? "");
          const lineId = String(params?.[1] ?? "");
          sellListLines = sellListLines.map((line) =>
            line.seller_account_id === sellerAccountId && line.line_id === lineId
              ? {
                  ...line,
                  quantity: Number(params?.[2] ?? line.quantity),
                  updated_at: String(params?.[3] ?? line.updated_at),
                }
              : line,
          );
          return { rows: [] };
        }

        if (/DELETE\s+FROM\s+checkout_sell_list_line_pages/i.test(sql)) {
          const sellerAccountId = String(params?.[0] ?? "");
          const lineIds = Array.isArray(params?.[1]) ? new Set(params[1].map(String)) : new Set<string>();
          sellListLines = sellListLines.filter(
            (line) => line.seller_account_id !== sellerAccountId || !lineIds.has(line.line_id),
          );
          return { rows: [] };
        }

        return { rows: sellListLines };
      }
      return { rows: [] };
    }),
  };

  return db;
}

async function seedSellListAggregate(
  services: ReturnType<typeof createCheckoutSellListRuntime>,
  lines: readonly CheckoutSellListLineRow[],
  allEvents: StoredEvent[],
) {
  for (const line of lines) {
    await services.commandHandler({
      streamId: `checkout.sell-list-${line.seller_account_id}`,
      command: {
        type: "AddSellListLine",
        sellerAccountId: line.seller_account_id as never,
        lineId: line.line_id as never,
        lineType: line.line_type,
        offerId: line.offer_id,
        listingId: line.listing_id,
        buyerAccountId: line.buyer_account_id,
        buyerDisplayName: line.buyer_display_name,
        offerPriceAmount: line.offer_price_amount,
        offerPriceCurrencyCode: line.offer_price_currency_code,
        offerStreamVersion: line.offer_stream_version,
        listingPriceAmount: line.listing_price_amount,
        listingPriceCurrencyCode: line.listing_price_currency_code,
        listingStreamVersion: line.listing_stream_version,
        catalogItemId: line.catalog_catalog_item_id,
        productId: line.product_id,
        itemTitle: line.item_title,
        itemSubtitle: line.item_subtitle,
        selectedOptions: line.selected_options,
        productSummary: line.product_summary,
        quantity: line.quantity,
        fallbackMode: line.fallback_mode,
        minimumListingPriceAmount: line.minimum_listing_price_amount,
      },
      context,
    });
  }

  allEvents.length = 0;
}

const sellerEvidence: SellListSellerConfirmationEvidence = {
  shipFrom: {
    status: "ready",
    addressId: "adr_seller",
    country: "US",
    region: "KS",
    postalCode: "67202",
  },
  payout: {
    status: "ready",
    method: "saved-payout",
    readinessStatus: "ready",
    lastCheckedAt: "2026-06-09T00:00:00.000Z",
  },
  label: {
    status: "ready",
    preference: "prepaid-label",
  },
  risk: { status: "clear" },
  provider: { status: "ready" },
  freshness: { status: "current" },
};

describe("sell list checkout runtime readiness boundary", () => {
  it("rejects unresolved sale-action readiness before seller checkout can confirm", async () => {
    const { allEvents, eventStore } = createInMemoryEventStore();
    const db = createDb([selectedOfferLine, productLine]);
    const services = createCheckoutSellListRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    await seedSellListAggregate(services, [selectedOfferLine, productLine], allEvents);
    // The selected offer's exact Listing is evidence-ready, so the only thing
    // holding checkout back is the product line's unresolved sale action.
    const readiness = await services.createReadinessSnapshot({ sellerAccountId: "acc_seller" });

    await expect(
      services.confirmSellListCheckout(
        {
          sellerAccountId: "acc_seller" as never,
          confirmationId: "slc_unresolved",
          readinessSnapshotId: readiness.snapshotId,
          readinessSourceRevision: readiness.sourceRevision,
        },
        context,
        marketplaceHandoffFixture(),
      ),
    ).rejects.toThrow("Sell List readiness must be resolved before seller checkout starts.");

    expect(allEvents).toEqual([]);
  });

  it("rejects stale sale-action readiness before emitting seller confirmation events", async () => {
    const readiness = createSellListReadinessSnapshot(
      [productLine],
      {
        lineActions: [{ lineId: "sll_product", action: "smart-match" }],
      },
      sellerEvidence,
    );
    const changedLine: CheckoutSellListLineRow = {
      ...productLine,
      updated_at: "2026-06-09T00:01:00.000Z",
    };
    const { allEvents, eventStore } = createInMemoryEventStore();
    const services = createCheckoutSellListRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createDb([changedLine]) as never,
    });
    await seedSellListAggregate(services, [changedLine], allEvents);

    await expect(
      services.confirmSellListCheckout(
        {
          sellerAccountId: "acc_seller" as never,
          confirmationId: "slc_stale",
          readinessSnapshotId: readiness.snapshotId,
          readinessSourceRevision: readiness.sourceRevision,
          readinessDecisions: {
            lineActions: [{ lineId: "sll_product", action: "smart-match" }],
          },
        },
        context,
        marketplaceHandoffFixture(),
      ),
    ).rejects.toThrow("Sell List readiness snapshot is stale.");

    expect(allEvents).toEqual([]);
  });

  it("rejects selected-offer confirmation when seller evidence was missing from readiness", async () => {
    const readiness = createSellListReadinessSnapshot([selectedOfferLine]);
    const { allEvents, eventStore } = createInMemoryEventStore();
    const services = createCheckoutSellListRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createDb([selectedOfferLine]) as never,
    });
    await seedSellListAggregate(services, [selectedOfferLine], allEvents);

    await expect(
      services.confirmSellListCheckout(
        {
          sellerAccountId: "acc_seller" as never,
          confirmationId: "slc_missing_seller_evidence",
          readinessSnapshotId: readiness.snapshotId,
          readinessSourceRevision: readiness.sourceRevision,
        },
        context,
        marketplaceHandoffFixture(),
      ),
    ).rejects.toThrow("Sell List readiness snapshot is stale.");

    expect(allEvents).toEqual([]);
  });

  it("rejects selected-offer confirmation when payout evidence is not ready", async () => {
    const f = checkoutOwnerRuntimeFixture();
    f.setPayout("restricted");
    const services = f.services;
    const allEvents = f.memory.allEvents;
    const readiness = await services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices });
    expect(readiness.sellerReadiness).toMatchObject({
      shipFrom: "ready",
      label: "ready",
      risk: "ready",
      provider: "ready",
      freshness: "ready",
      payout: "blocked",
    });

    await expect(
      services.confirmSellListCheckout(
        {
          sellerAccountId: "acc_seller" as never,
          confirmationId: "slc_restricted_payout",
          readinessSnapshotId: readiness.snapshotId,
          readinessSourceRevision: readiness.sourceRevision,

          ...choices,
        },
        context,
        marketplaceHandoffFixture(),
      ),
    ).rejects.toThrow("Seller confirmation evidence must be ready before Sell List checkout can confirm.");

    expect(allEvents).toEqual([]);
  });

  it("rejects product-line confirmation without stored review preparation", async () => {
    const decisions = {
      lineActions: [{ lineId: "sll_product", action: "smart-match" as const }],
    };
    const readiness = createSellListReadinessSnapshot([productLine], decisions, sellerEvidence);
    const { allEvents, eventStore } = createInMemoryEventStore();
    const services = createCheckoutSellListRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createDb([productLine]) as never,
    });
    await seedSellListAggregate(services, [productLine], allEvents);

    await expect(
      services.confirmSellListCheckout(
        {
          sellerAccountId: "acc_seller" as never,
          confirmationId: "slc_stale_seller_evidence",
          readinessSnapshotId: readiness.snapshotId,
          readinessSourceRevision: readiness.sourceRevision,
          readinessDecisions: decisions,
        },
        context,
        marketplaceHandoffFixture(),
      ),
    ).rejects.toThrow("Sell List readiness snapshot is stale.");

    expect(allEvents).toEqual([]);
  });

  it("keeps freshly projected Sell List rows visible when aggregate reads are still catching up", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = createDb([productLine]);
    const services = createCheckoutSellListRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await expect(services.listLines("acc_seller")).resolves.toEqual([productLine]);
    expect(db.query).not.toHaveBeenCalledWith(expect.stringContaining("DELETE FROM checkout_sell_list_line_pages"), [
      "acc_seller",
      ["sll_product"],
    ]);
  });

  it("projects product add-line commands into the account Sell List read model", async () => {
    const { allEvents, eventStore } = createInMemoryEventStore();
    const db = createDb(
      [],
      [
        {
          catalog_item_id: "cat_air_balloon",
          status: "active",
          product_schema: airBalloonProductSchema,
        },
      ],
    );
    const services = createCheckoutSellListRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    const result = await services.addLine(
      {
        attemptId: "sell-list-runtime-add-synthetic",
        requestHash: "a".repeat(64),
        sellerAccountId: "acc_seller" as never,
        lineType: "product",
        offerId: null,
        buyerAccountId: null,
        buyerDisplayName: null,
        offerPriceAmount: null,
        catalogItemId: "cat_air_balloon",
        productId: airBalloonProductId,
        itemTitle: "Air Balloon",
        itemSubtitle: "Scarlet & Violet 167/198",
        selectedOptions: [
          { dimensionId: "dim_seed_form", optionId: "chc_seed_form_raw" },
          { dimensionId: "dim_seed_condition", optionId: "chc_seed_condition_damaged" },
        ],
        productSummary: "Raw / Damaged",
        quantity: 1,
        fallbackMode: "none",
        minimumListingPriceAmount: null,
      },
      context,
    );
    const lineAddedEvent = allEvents.find((event) => event.eventType === "checkout.sell-list.line-added");

    expect(result).toMatchObject({
      lineId: expect.stringMatching(/^sll_/),
      version: 1,
      status: "added",
    });
    expect(lineAddedEvent?.payload).toMatchObject({
      sellerAccountId: "acc_seller",
      lineType: "product",
      productId: airBalloonProductId,
      productSummary: "Raw / Damaged",
      quantity: 1,
    });

    await services.projectors[0]?.handlers["checkout.sell-list.line-added"]?.(toTransportEvent(lineAddedEvent!));

    await expect(services.listLines("acc_seller")).resolves.toEqual([
      expect.objectContaining({
        seller_account_id: "acc_seller",
        line_id: result.lineId,
        line_type: "product",
        product_id: airBalloonProductId,
        item_title: "Air Balloon",
        product_summary: "Raw / Damaged",
        quantity: 1,
        fallback_mode: "none",
      }),
    ]);
  });

  it("treats duplicate selected-offer adds as already merged from the aggregate when projection is stale", async () => {
    const selectedOptions = [
      { dimensionId: "dim_seed_form", optionId: "chc_seed_form_raw" },
      { dimensionId: "dim_seed_condition", optionId: "chc_seed_condition_damaged" },
    ];
    const existingSelectedOfferLine: CheckoutSellListLineRow = {
      ...selectedOfferLine,
      catalog_catalog_item_id: "cat_air_balloon",
      product_id: airBalloonProductId,
      selected_options: selectedOptions,
      product_summary: "Raw / Damaged",
    };
    const { allEvents, eventStore } = createInMemoryEventStore();
    const services = createCheckoutSellListRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createDb(
        [],
        [
          {
            catalog_item_id: "cat_air_balloon",
            status: "active",
            product_schema: airBalloonProductSchema,
          },
        ],
      ) as never,
    });
    await seedSellListAggregate(services, [existingSelectedOfferLine], allEvents);

    await expect(
      services.addLine(
        {
          attemptId: "sell-list-runtime-merge-synthetic",
          requestHash: "b".repeat(64),
          sellerAccountId: "acc_seller" as never,
          lineType: "selected-offer",
          offerId: "off_ready",
          buyerAccountId: "acc_buyer",
          buyerDisplayName: "Jane Buyer",
          offerPriceAmount: "120.00",
          offerPriceCurrencyCode: "USD",
          offerStreamVersion: 3,
          listingPriceAmount: "125.00",
          listingPriceCurrencyCode: "USD",
          listingStreamVersion: 7,
          catalogItemId: "cat_air_balloon",
          productId: airBalloonProductId,
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions,
          productSummary: "Raw / Damaged",
          quantity: 1,
          fallbackMode: "none",
          minimumListingPriceAmount: null,
        },
        context,
      ),
    ).resolves.toMatchObject({
      lineId: "sll_offer",
      version: 1,
      status: "merged",
      commandReceipt: {
        mode: "eventual",
        commitPosition: "2",
        commitEventIds: ["evt_2"],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "2",
            eventIds: ["evt_2"],
          },
        ],
      },
    });
    expect(allEvents.map((event) => event.eventType)).toEqual(["checkout.command-attempt.completed"]);
  });

  it("merges anonymous aggregate lines even when the source projection is still empty", async () => {
    const anonymousProductLine: CheckoutSellListLineRow = {
      ...productLine,
      seller_account_id: "anon_sell_1",
      line_id: "sll_guest_product",
    };
    const { allEvents, eventStore } = createInMemoryEventStore();
    const services = createCheckoutSellListRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createDb([]) as never,
      sellerCheckoutOwners: ownerPortsFixture(),
    });
    await seedSellListAggregate(services, [anonymousProductLine], allEvents);

    await expect(
      services.mergeSellListIntoAccount(
        {
          sourceOwnerId: "anon_sell_1",
          targetAccountId: "acc_seller" as never,
        },
        context,
      ),
    ).resolves.toEqual({
      mergedLineCount: 1,
      commandReceipt: {
        mode: "eventual",
        commitPosition: "2",
        commitEventIds: ["evt_2"],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "2",
            eventIds: ["evt_2"],
          },
        ],
      },
    });

    expect(allEvents.map((event) => ({ streamId: event.streamId, eventType: event.eventType }))).toEqual([
      {
        streamId: "checkout.sell-list-acc_seller",
        eventType: "checkout.sell-list.line-added",
      },
      {
        streamId: "checkout.sell-list-anon_sell_1",
        eventType: "checkout.sell-list.line-removed",
      },
    ]);
    expect(allEvents[0]?.payload).toMatchObject({
      sellerAccountId: "acc_seller",
      lineId: "sll_guest_product",
      productId: "cat_2::form:raw",
    });
  });

  it("returns the stored target receipt when an anonymous selected-offer merge is replayed", async () => {
    const anonymousSelectedOfferLine: CheckoutSellListLineRow = {
      ...selectedOfferLine,
      seller_account_id: "anon_sell_1",
    };
    const targetSelectedOfferLine: CheckoutSellListLineRow = {
      ...selectedOfferLine,
      seller_account_id: "acc_seller",
    };
    const { allEvents, eventStore } = createInMemoryEventStore();
    const services = createCheckoutSellListRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createDb([]) as never,
      sellerCheckoutOwners: ownerPortsFixture(),
    });
    await seedSellListAggregate(services, [anonymousSelectedOfferLine, targetSelectedOfferLine], allEvents);

    await expect(
      services.mergeSellListIntoAccount(
        {
          sourceOwnerId: "anon_sell_1",
          targetAccountId: "acc_seller" as never,
        },
        context,
      ),
    ).resolves.toEqual({
      mergedLineCount: 1,
      commandReceipt: {
        mode: "eventual",
        commitPosition: "2",
        commitEventIds: ["evt_2"],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "2",
            eventIds: ["evt_2"],
          },
        ],
      },
    });

    expect(allEvents.map((event) => ({ streamId: event.streamId, eventType: event.eventType }))).toEqual([
      {
        streamId: "checkout.sell-list-anon_sell_1",
        eventType: "checkout.sell-list.line-removed",
      },
    ]);
  });

  it("treats removing an already-absent aggregate line as a projected-row repair", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = createDb([productLine]);
    const services = createCheckoutSellListRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await expect(
      services.removeLine(
        {
          sellerAccountId: "acc_seller" as never,
          lineId: "sll_product" as never,
          attemptId: "sell-list-runtime-remove-synthetic",
          requestHash: "c".repeat(64),
        },
        context,
      ),
    ).resolves.toMatchObject({ lineId: "sll_product", version: 0 });
    await expect(services.listLines("acc_seller")).resolves.toEqual([]);
  });
});

describe("AC4 composed readiness, pre-confirm and merge timing", () => {
  it.each(["manual", "saved", "smart-match", "pg-versions", "missing-fulfillment", "evidence-drift"])(
    "runs the fully-ready selected offer through the real seller review action and owner reread: %s",
    async (scenario) => {
      const f = checkoutOwnerRuntimeFixture();
      const line =
        scenario === "smart-match"
          ? { ...fixtureLine, line_type: "product" as const, offer_id: null, listing_id: null }
          : fixtureLine;
      f.setLines([line]);
      if (scenario === "pg-versions") {
        f.setLines([{ ...line, offer_stream_version: "1" as never, listing_stream_version: "1" as never }]);
        f.setOfferStreamVersion("1");
      }
      if (scenario === "missing-fulfillment")
        f.ports.resolveOrigin.mockResolvedValue({ status: "blocked", fact: "missing" });
      await seedSellListAggregate(f.services, [line], f.memory.allEvents);
      const decisions = {
        lineActions: [
          {
            lineId: fixtureLine.line_id,
            action: scenario === "smart-match" ? ("smart-match" as const) : ("selected-offer" as const),
          },
        ],
      };
      const issued = await f.services.createReviewReadiness(
        {
          sellerAccountId: "acc_seller",
          selections: {
            lines: [
              {
                lineId: line.line_id,
                selectedOfferFeeQuoteFingerprint: "synthetic_quote",
                productOffers:
                  scenario === "smart-match"
                    ? [{ offerId: "off_fixture", feeQuoteFingerprint: "synthetic_quote" }]
                    : [],
              },
            ],
          },
        },
        context,
      );
      const initial = issued.readiness;
      const assess = vi.fn(async (body: Record<string, unknown>) =>
        body.readinessSnapshotId
          ? f.services.getReviewReadiness({
              sellerAccountId: "acc_seller",
              snapshotId: String(body.readinessSnapshotId),
              sourceRevision: String(body.readinessSourceRevision),
              confirmationId: String(body.confirmationId),
            })
          : {
              readiness: await f.services.createReadinessSnapshot(
                {
                  sellerAccountId: "acc_seller",
                  decisions: parseSellListReadinessDecisionInput(body),
                  ...(body.confirmationId ? { confirmationId: String(body.confirmationId) } : {}),
                  ...(body.entryReadinessSnapshotId
                    ? { entryReadinessSnapshotId: String(body.entryReadinessSnapshotId) }
                    : {}),
                  ...(body.entryReadinessSourceRevision
                    ? { entryReadinessSourceRevision: String(body.entryReadinessSourceRevision) }
                    : {}),
                  ...parseSellerCheckoutChoices(body),
                },
                context,
              ),
            },
      );
      const confirm = vi.fn(
        async (
          body: Parameters<
            ReturnType<typeof checkoutRequest.createCheckoutRequestApiClient>["confirmSellListCheckout"]
          >[0],
        ) => {
          try {
            return await f.services.confirmSellListCheckout(
              { ...body, sellerAccountId: "acc_seller" as never },
              context,
              marketplaceRequest.createMarketplaceRequestApiClient(new Request("http://localhost")),
            );
          } catch (error) {
            throw new checkoutRequest.CheckoutApiError(400, {
              error: { message: error instanceof Error ? error.message : "Refused" },
            });
          }
        },
      );
      const spies = [
        vi.spyOn(auth, "resolveActorFromAuthApi").mockResolvedValue({
          accountId: "acc_seller",
          permissions: ["accounts.view"],
        } as never),
        vi.spyOn(checkoutRequest, "createCheckoutRequestApiClient").mockReturnValue({
          getSellList: async () => ({ items: [line] }),
          listSellListShipFromAddresses: async () => (scenario === "saved" ? [f.address] : []),
          getSellListPayoutReadiness: async () => ({ status: "ready" }),
          getSellListConfirmation: (id: string) =>
            f.services.getConfirmation("acc_seller", id).then((row) => {
              if (!row) throw new checkoutRequest.CheckoutApiError(404, {});
              return row;
            }),
          createSellListReadiness: assess,
          confirmSellListCheckout: confirm,
        } as never),
        vi.spyOn(marketplaceRequest, "createMarketplaceRequestApiClient").mockReturnValue({
          acceptOfferMatch: vi.fn(async () => {
            f.setOfferAvailable(false);
            if (scenario === "evidence-drift")
              f.getListingEvidence()!.evidence_requirements.policyHash = "synthetic_policy_changed";
            const refreshedAt = "2026-11-07T01:02:03.000Z";
            await buildCheckoutMarketplaceSellerOptionsProjectionHandlers(f.db as never)[
              "marketplace.listing.evidence-requirements-refreshed"
            ]!(
              buildTransportEvent(
                "marketplace.listing.evidence-requirements-refreshed",
                {
                  evidenceRequirements: { ...f.getListingEvidence()!.evidence_requirements, evaluatedAt: refreshedAt },
                },
                {
                  streamId: "marketplace.listing-lst_fixture",
                  timing: { occurredAt: refreshedAt, recordedAt: refreshedAt },
                },
              ),
            );
            return { status: "accepted" };
          }),
          getOfferAcceptanceAttempt: async (
            id: string,
            body: Record<string, unknown> & { sourceActionKey: string },
          ) => ({
            schemaVersion: 1,
            mutationKind: "offer.accept",
            ownerStatus: "committed",
            actorBinding: { accountId: "acc_seller" },
            target: { kind: "offer", id },
            attemptKeyFingerprint: createHash("sha256").update(body.sourceActionKey).digest("hex"),
            canonicalRequestHash: await marketplaceRequest.hashMarketplaceRequest(
              marketplaceRequest.marketplaceOfferCanonicalRequest("offer.accept", { ...body, offerId: id }),
            ),
            ownerReceipt: { id, version: 4 },
          }),
        } as never),
        vi
          .spyOn(postWrite, "navigateAfterWriteFromSourcesWithPlatformPostWriteToken")
          .mockResolvedValue("/checkout/sell/session/chk_selected/confirmation"),
      ];
      try {
        const form = new URLSearchParams({
          readinessSnapshotId: initial.snapshotId,
          readinessSourceRevision: initial.sourceRevision,
          readinessDecisions: JSON.stringify(decisions),
          sellListReviewPlan: JSON.stringify({
            version: 1,
            lines: [
              {
                lineId: fixtureLine.line_id,
                lineType: line.line_type,
                itemTitle: fixtureLine.item_title,
                productId: fixtureLine.product_id,
                quantity: fixtureLine.quantity,
                selectedOffer:
                  scenario === "smart-match"
                    ? null
                    : {
                        offerId: fixtureLine.offer_id,
                        listingId: fixtureLine.listing_id,
                        feeQuoteFingerprint: "synthetic_quote",
                      },
                productOfferTargets:
                  scenario === "smart-match"
                    ? [
                        {
                          offerId: fixtureLine.offer_id,
                          listingId: fixtureLine.listing_id,
                          feeQuoteFingerprint: "synthetic_quote",
                          quantity: 1,
                        },
                      ]
                    : [],
                fallbackListing: null,
                skippedReasons: [],
              },
            ],
          }),
          sellerName: choices.shipFrom.name,
          email: "synthetic@example.com",
          shipFromAddressId: scenario === "saved" ? f.address.shipping_address_id : "__manual",
          shipFromName: choices.shipFrom.name,
          shipFromLine1: choices.shipFrom.line1,
          shipFromCity: choices.shipFrom.city,
          shipFromState: choices.shipFrom.state,
          shipFromPostalCode: choices.shipFrom.postalCode,
          shipFromCountry: choices.shipFrom.country,
          payoutMethod: "saved-payout",
          labelPreference: "prepaid-label",
          termsAccepted: "accepted",
          payoutState: "ready",
          payoutEstimateState: "current",
          riskState: "clear",
          labelState: "ready",
          sellerReadinessState: "ready",
        });
        const result = await sellCheckoutAction({
          request: new Request("http://localhost/checkout/sell/session/chk_selected", {
            method: "POST",
            body: form,
          }),
          params: { sessionId: "chk_selected" },
          context: undefined,
        } as never);
        const expectedChoices =
          scenario === "saved" ? { ...choices, shipFrom: { addressId: f.address.shipping_address_id } } : choices;
        expect(assess).toHaveBeenLastCalledWith(expect.objectContaining(expectedChoices));
        if (scenario === "missing-fulfillment") {
          expect(result).toMatchObject({
            status: "error",
            fieldErrors: {
              form:
                scenario === "missing-fulfillment"
                  ? "Sell List readiness must be resolved before handoff."
                  : "Sell List readiness snapshot is stale.",
            },
          });
          expect(f.memory.allEvents.map((event) => event.eventType)).toEqual(
            scenario === "missing-fulfillment"
              ? ["checkout.sell-list.review-planned"]
              : ["checkout.sell-list.review-planned", "checkout.sell-list.handoff-prepared"],
          );
          if (scenario === "missing-fulfillment") expect(confirm).not.toHaveBeenCalled();
          return;
        }
        expect(result, JSON.stringify("fieldErrors" in result ? result.fieldErrors : null)).toBeInstanceOf(Response);
        expect((result as Response).headers.get("Location")).toContain("/confirmation");
        expect(confirm).toHaveBeenCalledWith(expect.objectContaining(expectedChoices));
        expect(f.memory.allEvents.map((event) => event.eventType)).toContain("checkout.sell-list.checkout-confirmed");
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    },
  );

  it.each(["unchanged", "missing", "incomplete", "invalid-timestamp", "policy-hash", "policy-version", "timestamp"])(
    "revalidates Smart Match %s evidence before confirmation events with unchanged payout",
    async (change) => {
      const f = checkoutOwnerRuntimeFixture();
      const line = { ...fixtureLine, line_type: "product" as const, offer_id: null, listing_id: null };
      f.setLines([line]);
      await seedSellListAggregate(f.services, [line], f.memory.allEvents);
      const decisions = { lineActions: [{ lineId: line.line_id, action: "smart-match" as const }] };
      const request = { sellerAccountId: "acc_seller", ...choices, decisions };
      const before = await prepareSellerConfirmation(f.services, "slc_smart_match_evidence", context, {
        lines: [{ lineId: line.line_id, productOffers: [{ offerId: "off_fixture", feeQuoteFingerprint: "quote" }] }],
      });
      expect(before.sellerReadiness.status).toBe("ready");
      const eventsBeforeConfirm = f.memory.allEvents.length;
      const evidence = structuredClone(f.getListingEvidence()!);
      f.setListingEvidence(evidence);
      if (change === "missing") f.setListingEvidence(null);
      if (change === "incomplete") evidence.evidence_requirements.requirements.minimumPhotoCount = 1;
      if (change === "invalid-timestamp") evidence.updated_at = "not-a-timestamp";
      if (change === "policy-hash") evidence.evidence_requirements.policyHash = "synthetic_policy_changed";
      if (change === "policy-version") evidence.evidence_requirements.policyVersion = 2;
      if (change === "timestamp") evidence.updated_at = "2026-11-06T01:02:04.000Z";
      const after = await f.services.createReadinessSnapshot(request);
      expect(after.ownerReads?.estimate).toEqual(before.ownerReads?.estimate);
      expect(after.sellerReadiness.status).toBe(
        ["missing", "incomplete", "invalid-timestamp"].includes(change) ? "blocked" : "ready",
      );
      const confirm = f.services.confirmSellListCheckout(
        {
          ...request,
          sellerAccountId: "acc_seller" as never,
          confirmationId: "slc_smart_match_evidence",
          readinessSnapshotId: before.snapshotId,
          readinessSourceRevision: before.sourceRevision,
          readinessDecisions: before.decisions,
        },
        context,
        marketplaceHandoffFixture(),
      );
      if (change === "unchanged") {
        expect(after.snapshotId).toBe(before.snapshotId);
        await expect(confirm).resolves.toMatchObject({ status: "confirmed" });
        expect(f.memory.allEvents.map((event) => event.eventType)).toContain("checkout.sell-list.checkout-confirmed");
      } else {
        expect(after.snapshotId).not.toBe(before.snapshotId);
        await expect(confirm).rejects.toThrow("Sell List readiness snapshot is stale.");
        expect(f.memory.allEvents).toHaveLength(eventsBeforeConfirm);
      }
    },
  );

  it("reads the same owner/key twice, records risk-only drift and emits an executed timing capture", async () => {
    const f = checkoutOwnerRuntimeFixture();
    await seedSellListAggregate(f.services, [fixtureLine], f.memory.allEvents);
    const readiness = await prepareSellerConfirmation(f.services, "slc_timing", context);
    expect(readiness.sellerReadiness.status).toBe("ready");
    f.ports.readRisk.mockResolvedValue({
      ...ownedAbsentRisk,
      rowState: "present",
      sourceRevision: 4,
      sourceTimestamp: stamp as never,
    });
    const confirmed = await f.services.confirmSellListCheckout(
      {
        sellerAccountId: "acc_seller" as never,
        confirmationId: "slc_timing",
        readinessSnapshotId: readiness.snapshotId,
        readinessSourceRevision: readiness.sourceRevision,
        readinessDecisions: readiness.decisions,

        ...choices,
      },
      context,
      marketplaceHandoffFixture(),
    );
    expect(confirmed.status).toBe("confirmed");
    expect(f.ports.readRisk.mock.calls).toEqual([
      [{ kind: "account", accountId: "acc_seller" }],
      [{ kind: "account", accountId: "acc_seller" }],
      [{ kind: "account", accountId: "acc_seller" }],
      [{ kind: "account", accountId: "acc_seller" }],
    ]);
    expect(f.ports.readFulfillment.mock.calls[1]).toEqual(f.ports.readFulfillment.mock.calls[0]);
    const evidence = confirmed.confirmation.seller_evidence;
    if (!evidence || typeof evidence !== "object" || !("ownerReads" in evidence))
      throw new Error("Missing owner capture");
    const captured = evidence.ownerReads;
    expect(captured).toMatchObject({
      moment: "pre-confirm",
      confirmationId: "slc_timing",
      owner: { kind: "account", accountId: "acc_seller" },
      risk: { sourceRevision: 4, sourceTimestamp: stamp },
    });
    await mkdir("../../artifacts/seller-checkout-owner-reads", { recursive: true });
    await writeFile(
      "../../artifacts/seller-checkout-owner-reads/authority-timing-probe.json",
      JSON.stringify({ readiness: readiness.ownerReads, preConfirm: captured }, null, 2) + "\n",
    );
  });

  it("refuses coherent Fulfillment revision drift before any confirmation event", async () => {
    const f = checkoutOwnerRuntimeFixture();
    await seedSellListAggregate(f.services, [fixtureLine], f.memory.allEvents);
    const readiness = await prepareSellerConfirmation(f.services, "slc_drift", context);
    const eventsBeforeConfirm = f.memory.allEvents.length;
    const resolved = await f.ports.resolveOrigin(
      { kind: "account", accountId: "acc_seller" as never },
      { origin: choices.shipFrom, labelPreference: choices.label.preference },
    );
    if (resolved.status !== "accepted") throw new Error("Invalid fixture");
    f.ports.resolveOrigin.mockResolvedValue({ ...resolved, sourceRevision: 3 });
    const fulfillment = await f.ports.readFulfillment(resolved.key);
    f.ports.readFulfillment.mockResolvedValue({ ...fulfillment, sourceRevision: 3 });
    await expect(
      f.services.confirmSellListCheckout(
        {
          sellerAccountId: "acc_seller" as never,
          confirmationId: "slc_drift",
          readinessSnapshotId: readiness.snapshotId,
          readinessSourceRevision: readiness.sourceRevision,
          readinessDecisions: readiness.decisions,

          ...choices,
        },
        context,
        marketplaceHandoffFixture(),
      ),
    ).rejects.toThrow("Sell List readiness snapshot is stale.");
    expect(f.memory.allEvents).toHaveLength(eventsBeforeConfirm);
  });

  it("fences even an empty merge and every replay before reading aggregates", async () => {
    const f = checkoutOwnerRuntimeFixture("anon_list");
    f.setLines([]);
    const read = vi.spyOn(f.memory.eventStore, "readStream");
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        f.services.mergeSellListIntoAccount(
          { sourceOwnerId: "anon_list", targetAccountId: "acc_seller" as never },
          context,
        ),
      ).resolves.toEqual({ mergedLineCount: 0 });
    }
    expect(f.ports.invalidateAnonymousOwner).toHaveBeenCalledTimes(2);
    expect(f.ports.invalidateAnonymousOwner.mock.invocationCallOrder[0]).toBeLessThan(
      read.mock.invocationCallOrder[0]!,
    );
    expect(f.ports.invalidateAnonymousOwner).toHaveBeenCalledWith(
      { owner: { kind: "anonymous", anonymousSellListId: "anon_list" }, targetAccountId: "acc_seller" },
      context,
    );
  });

  it("refuses missing, failed and malformed invalidation without reading or mutating lines", async () => {
    const f = checkoutOwnerRuntimeFixture("anon_list");
    const read = vi.spyOn(f.memory.eventStore, "readStream");
    const params = { sourceOwnerId: "anon_list", targetAccountId: "acc_seller" as never };
    await expect(
      createCheckoutSellListRuntime({ ...f.deps, sellerCheckoutOwners: undefined }).mergeSellListIntoAccount(
        params,
        context,
      ),
    ).rejects.toThrow("cannot be invalidated");
    f.ports.invalidateAnonymousOwner.mockRejectedValueOnce(new Error("durable fence failed"));
    await expect(f.services.mergeSellListIntoAccount(params, context)).rejects.toThrow("durable fence failed");
    f.ports.invalidateAnonymousOwner.mockResolvedValueOnce({ revision: 0, recordedAt: stamp as never });
    await expect(f.services.mergeSellListIntoAccount(params, context)).rejects.toThrow("cannot be invalidated");
    expect(read).not.toHaveBeenCalled();
    expect(f.memory.allEvents).toEqual([]);
  });
});

describe("API builds the existing Sell List review allocation", () => {
  const product = { ...productLine, quantity: 5 };
  const fallback = { inventoryItemId: "inv_1", priceAmount: "12.50", priceCurrencyCode: "USD", quantityCap: "9" };
  const target = (offerId: string, feeQuoteFingerprint = "quote_" + offerId) => ({ offerId, feeQuoteFingerprint });
  const match = vi.fn(async (offerId: string): Promise<CheckoutSellOfferMatch | null> => {
    if (offerId === "unavailable") throw new Error("Offer match not found.");
    return {
      offer_id: offerId,
      listing_id: "lst_" + offerId,
      product_id: offerId === "wrong" ? "other_product" : product.product_id,
      quantity_requested: offerId === "two" ? 2 : offerId === "large" ? 5 : 1,
    } as CheckoutSellOfferMatch;
  });

  it("preserves selected Offers and requires their fingerprint", async () => {
    const plan = await buildSellListReviewPlan(match, [selectedOfferLine], {
      lines: [
        {
          lineId: selectedOfferLine.line_id,
          selectedOfferFeeQuoteFingerprint: "selected_quote",
        },
      ],
    });
    expect(plan.lines[0]).toEqual({
      lineId: selectedOfferLine.line_id,
      lineType: "selected-offer",
      itemTitle: "Charizard",
      productId: selectedOfferLine.product_id,
      quantity: 1,
      selectedOffer: { offerId: "off_ready", listingId: "lst_ready", feeQuoteFingerprint: "selected_quote" },
      productOfferTargets: [],
      fallbackListing: null,
      skippedReasons: [],
    });
    expect(readinessDecisionsFromReviewPlan(plan)).toEqual({
      lineActions: [{ lineId: "sll_offer", action: "selected-offer" }],
      lineOutcomes: [],
    });
    const missing = await buildSellListReviewPlan(match, [selectedOfferLine], { lines: [] });
    expect(missing.lines[0]!.selectedOffer).toBeNull();
    expect(missing.lines[0]!.skippedReasons).toEqual(["Charizard: offer terms need refresh."]);
    expect(readinessDecisionsFromReviewPlan(missing).lineOutcomes).toEqual([
      { lineId: "sll_offer", outcome: "keep-in-list" },
    ]);
    const absent = await buildSellListReviewPlan(match, [{ ...selectedOfferLine, offer_id: null }], { lines: [] });
    expect(absent.lines[0]!.skippedReasons).toEqual(["Charizard: selected offer is missing."]);
  });

  it("keeps ordered splits, deduplicates targets and caps fallback at the remainder", async () => {
    match.mockClear();
    const plan = await buildSellListReviewPlan(match, [product], {
      lines: [
        {
          lineId: product.line_id,
          productOffers: [target("two"), target("one"), target("two")],
          fallbackListing: fallback,
        },
      ],
    });
    expect(plan.lines[0]!.productOfferTargets).toEqual([
      { offerId: "two", listingId: "lst_two", feeQuoteFingerprint: "quote_two", quantity: 2 },
      { offerId: "one", listingId: "lst_one", feeQuoteFingerprint: "quote_one", quantity: 1 },
    ]);
    expect(plan.lines[0]!.fallbackListing).toEqual({ ...fallback, quantityCap: 2 });
    expect(plan.lines[0]!.skippedReasons).toEqual([]);
    expect(match.mock.calls.map(([id]) => id)).toEqual(["two", "one"]);
    expect(readinessDecisionsFromReviewPlan(plan)).toEqual({
      lineActions: [{ lineId: "sll_product", action: "smart-match" }],
      lineOutcomes: [],
    });
  });

  it.each([
    ["wrong", "quote", "Blastoise: matching offer wrong no longer matches this product."],
    ["unavailable", "quote", "Blastoise: Offer match not found."],
    ["large", "quote", "Blastoise: matching offer large exceeds remaining quantity."],
    ["one", "", "Blastoise: matching offer terms need refresh."],
  ])("retains skipped reasons for %s without overallocating", async (offerId, fingerprint, reason) => {
    const plan = await buildSellListReviewPlan(match, [product], {
      lines: [
        {
          lineId: product.line_id,
          productOffers: [target("two"), target(offerId!, fingerprint)],
          fallbackListing: fallback,
        },
      ],
    });
    expect(plan.lines[0]!.productOfferTargets).toEqual([
      { offerId: "two", listingId: "lst_two", feeQuoteFingerprint: "quote_two", quantity: 2 },
    ]);
    expect(plan.lines[0]!.fallbackListing?.quantityCap).toBe(3);
    expect(plan.lines[0]!.skippedReasons).toEqual([reason]);
    expect(readinessDecisionsFromReviewPlan(plan)).toEqual({
      lineActions: [],
      lineOutcomes: [{ lineId: "sll_product", outcome: "keep-in-list" }],
    });
  });

  it("keeps fallback-only partial caps and unresolved remainder behavior", async () => {
    const plan = await buildSellListReviewPlan(match, [product], {
      lines: [
        {
          lineId: product.line_id,
          fallbackListing: { ...fallback, quantityCap: "1" },
        },
      ],
    });
    expect(plan.lines[0]!.fallbackListing).toEqual({ ...fallback, quantityCap: 1 });
    expect(readinessDecisionsFromReviewPlan(plan).lineActions).toEqual([
      { lineId: "sll_product", action: "fallback-listing" },
    ]);
    const unresolved = await buildSellListReviewPlan(match, [product], { lines: [] });
    expect(unresolved.lines[0]!.skippedReasons).toEqual([
      "Blastoise: matching offers do not cover the requested quantity.",
    ]);
    const invalid = await buildSellListReviewPlan(match, [product], {
      lines: [
        {
          lineId: product.line_id,
          fallbackListing: { ...fallback, inventoryItemId: "" },
        },
      ],
    });
    expect(invalid.lines[0]!.fallbackListing).toBeNull();
    expect(invalid.lines[0]!.skippedReasons).toEqual([
      "Blastoise: listing needs inventory, price, currency, and quantity.",
    ]);
  });

  it("filters bulk selections, retains unselected lines, and never adds fallback", async () => {
    const plan = await buildSellListReviewPlan(match, [selectedOfferLine, product], {
      bulkOfferIds: ["one"],
      lines: [
        { lineId: selectedOfferLine.line_id, selectedOfferFeeQuoteFingerprint: "quote" },
        { lineId: product.line_id, productOffers: [target("two"), target("one")], fallbackListing: fallback },
      ],
    });
    expect(plan.lines).toHaveLength(2);
    expect(plan.lines[0]).toMatchObject({ selectedOffer: null, skippedReasons: [] });
    expect(plan.lines[1]).toMatchObject({
      productOfferTargets: [{ offerId: "one", listingId: "lst_one", feeQuoteFingerprint: "quote_one", quantity: 1 }],
      fallbackListing: null,
      skippedReasons: [],
    });
    expect(readinessDecisionsFromReviewPlan(plan)).toEqual({
      lineActions: [{ lineId: "sll_product", action: "smart-match" }],
      lineOutcomes: [{ lineId: "sll_offer", outcome: "keep-in-list" }],
    });
  });
});

describe("API-owned Marketplace handoff", () => {
  function barrier() {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    return {
      entered,
      release,
      wait: async () => {
        enter();
        await released;
      },
    };
  }

  async function prepared() {
    const f = checkoutOwnerRuntimeFixture();
    const lines: readonly CheckoutSellListLineRow[] = [
      fixtureLine,
      { ...fixtureLine, line_id: "sll_match", line_type: "product", offer_id: null, listing_id: null, quantity: 4 },
      {
        ...fixtureLine,
        line_id: "sll_zfallback",
        line_type: "product",
        offer_id: null,
        listing_id: null,
        minimum_listing_price_amount: "10.00",
      },
    ];
    f.setLines(lines);
    const query = f.db.query.getMockImplementation()!;
    f.db.query.mockImplementation(async (sql, args) => {
      if (String(sql).includes("FROM checkout_supply_items"))
        return {
          rows: [
            {
              item_id: "inv_fallback",
              product_id: fixtureLine.product_id,
              available_quantity: 10,
              selected_options: [],
            },
          ],
        } as never;
      const result = await query(sql, args);
      if (String(sql).includes("WHERE offer.offer_id = $2")) {
        return {
          rows: result.rows.map((row) => ({
            ...row,
            offer_id: String(args?.[1]),
            listing_id: args?.[1] === "off_fixture" ? "lst_fixture" : "lst_" + String(args?.[1]),
          })),
        } as never;
      }
      return result;
    });
    const selected = fixtureLine;
    f.setLines([selected, ...lines.slice(1)]);
    await seedSellListAggregate(f.services, [selected, ...lines.slice(1)], f.memory.allEvents);
    const readiness = await prepareSellerConfirmation(f.services, "slc_api", context, {
      lines: [
        { lineId: selected.line_id, selectedOfferFeeQuoteFingerprint: "selected_quote" },
        {
          lineId: "sll_match",
          productOffers: [
            { offerId: "off_one", feeQuoteFingerprint: "one_quote" },
            { offerId: "off_two", feeQuoteFingerprint: "two_quote" },
          ],
          fallbackListing: {
            inventoryItemId: "inv_match",
            priceAmount: "10.00",
            priceCurrencyCode: "USD",
            quantityCap: "1",
          },
        },
        {
          lineId: "sll_zfallback",
          fallbackListing: {
            inventoryItemId: "inv_fallback",
            priceAmount: "10.00",
            priceCurrencyCode: "USD",
            quantityCap: "1",
          },
        },
      ],
    });
    const request = {
      sellerAccountId: "acc_seller" as never,
      confirmationId: "slc_api",
      ...choices,
      readinessSnapshotId: readiness.snapshotId,
      readinessSourceRevision: readiness.sourceRevision,
      readinessDecisions: readiness.decisions,
    };
    const marketplace = marketplaceHandoffFixture();
    return { f, request, marketplace };
  }

  it("confirm runs the stored-plan selected-offer, smart-match and fallback handoff", async () => {
    const { f, request, marketplace } = await prepared();
    const result = await f.services.confirmSellListCheckout(request, context, marketplace);
    expect(marketplace.acceptOfferMatch.mock.calls).toEqual([
      [
        "off_fixture",
        {
          listingId: "lst_fixture",
          feeQuoteFingerprint: "selected_quote",
          sourceActionKey: "sell-confirm:slc_api:sll_fixture:selected:off_fixture",
        },
      ],
      [
        "off_one",
        {
          listingId: "lst_off_one",
          feeQuoteFingerprint: "one_quote",
          sourceActionKey: "sell-confirm:slc_api:sll_match:match:off_one",
          acceptanceBatchId: "offer-acceptance:slc_api:sll_match",
          acceptanceBatchSize: 2,
        },
      ],
      [
        "off_two",
        {
          listingId: "lst_off_two",
          feeQuoteFingerprint: "two_quote",
          sourceActionKey: "sell-confirm:slc_api:sll_match:match:off_two",
          acceptanceBatchId: "offer-acceptance:slc_api:sll_match",
          acceptanceBatchSize: 2,
        },
      ],
    ]);
    expect(marketplace.createListing.mock.calls.map(([body]) => body)).toEqual([
      expect.objectContaining({
        inventoryItemId: "inv_match",
        listingIdOverride: "lst_slc_api_sll_match",
        quantityCap: 1,
      }),
      expect.objectContaining({
        inventoryItemId: "inv_fallback",
        listingIdOverride: "lst_slc_api_sll_zfallback",
        quantityCap: 1,
      }),
    ]);
    expect(marketplace.acceptOfferMatch.mock.invocationCallOrder[2]).toBeLessThan(
      marketplace.createListing.mock.invocationCallOrder[0]!,
    );
    expect(marketplace.publishListing.mock.calls.map(([id]) => id)).toEqual([
      "lst_slc_api_sll_match",
      "lst_slc_api_sll_zfallback",
    ]);
    const event = f.memory.allEvents.find((event) => event.eventType === "checkout.sell-list.checkout-confirmed")!;
    expect(event.payload).toMatchObject({
      completedLineIds: ["sll_fixture", "sll_zfallback"],
      remainingLineQuantities: [{ lineId: "sll_match", quantity: 1 }],
      handoffSummary: {
        acceptedOfferCount: 3,
        publishedListingCount: 2,
        skippedLineCount: 0,
        lineOutcomes: [
          expect.objectContaining({ status: "completed" }),
          expect.objectContaining({ status: "partial", action: "mixed", remainingQuantity: 1 }),
          expect.objectContaining({ status: "completed" }),
        ],
        sideEffects: { sale: "handoff-recorded", payout: "pending-downstream" },
      },
    });
    expect(result.confirmation.handoff_summary).toEqual(event.payload.handoffSummary);
  });

  it("posted handoff results cannot change the API-observed confirmation", async () => {
    const { f, request, marketplace } = await prepared();
    const result = await f.services.confirmSellListCheckout(
      {
        ...request,
        handoffSummary: { acceptedOfferCount: 999 },
        completedLineIds: ["sll_attacker"],
        remainingLineQuantities: [{ lineId: "sll_fixture", quantity: 999 }],
      } as typeof request,
      context,
      marketplace,
    );
    expect(result.completedLineIds).toEqual(["sll_fixture", "sll_zfallback"]);
    expect(result.confirmation.handoff_summary.acceptedOfferCount).toBe(3);
    const count = f.memory.allEvents.length;
    await expect(f.services.confirmSellListCheckout(request, context, marketplace)).resolves.toEqual(result);
    expect(f.memory.allEvents).toHaveLength(count);
    expect(marketplace.acceptOfferMatch).toHaveBeenCalledTimes(3);
  });

  it("returns Marketplace source receipts on the first response, not on authoritative replay", async () => {
    const { f, request, marketplace } = await prepared();
    const commandReceipt = {
      mode: "eventual",
      commitPosition: "42",
      commitEventIds: ["evt_marketplace"],
      commitPositions: [{ sourceContextName: "marketplace", maxGlobalPosition: "42", eventIds: ["evt_marketplace"] }],
    } as const;
    marketplace.acceptOfferMatch.mockResolvedValueOnce({ id: "off_fixture", version: 4, commandReceipt } as never);
    const result = await f.services.confirmSellListCheckout(request, context, marketplace);
    expect(result.sourceReceipts).toEqual([{ commandReceipt }]);
    const replay = await f.services.confirmSellListCheckout(request, context, marketplace);
    expect(replay.confirmation).toEqual(result.confirmation);
    expect(replay.sourceReceipts).toEqual([]);
  });

  it.each(["aggregate read", "owner readiness reads"] as const)(
    "replays the winner when an identical retry overlaps at the %s",
    async (stage) => {
      const { f, request, marketplace } = await prepared();
      const append = vi.spyOn(f.memory.eventStore, "appendToStream");
      const originalBarrier = barrier();
      const accept = marketplace.acceptOfferMatch.getMockImplementation()!;
      marketplace.acceptOfferMatch.mockImplementationOnce(async (...args) => {
        await originalBarrier.wait();
        return accept(...args);
      });
      const original = f.services.confirmSellListCheckout(request, context, marketplace);
      expect(await Promise.race([originalBarrier.entered, original])).toBeUndefined();

      const retryBarrier = barrier();
      if (stage === "aggregate read") {
        const read = f.memory.eventStore.readStream.bind(f.memory.eventStore);
        vi.spyOn(f.memory.eventStore, "readStream")
          .mockImplementationOnce(read) // First stream read reports no confirmation.
          .mockImplementationOnce(async (input) => {
            await retryBarrier.wait();
            return read(input);
          });
      } else {
        f.ports.readRisk.mockImplementationOnce(async () => {
          await retryBarrier.wait();
          return ownedAbsentRisk;
        });
      }

      const retryMarketplace = marketplaceHandoffFixture();
      const retry = f.services.confirmSellListCheckout(request, context, retryMarketplace);
      try {
        expect(await Promise.race([retryBarrier.entered, retry])).toBeUndefined();
        originalBarrier.release();
        const winner = await original;
        expect(append).toHaveBeenCalledOnce();
        if (stage === "owner readiness reads") f.setPayout("restricted");
        retryBarrier.release();

        await expect(retry).resolves.toEqual(winner);
        for (const operation of Object.values(retryMarketplace)) expect(operation).not.toHaveBeenCalled();
        expect(append).toHaveBeenCalledOnce();
      } finally {
        originalBarrier.release();
        retryBarrier.release();
        await Promise.allSettled([original, retry]);
      }
    },
  );

  it("confirmation duplicate is write-free", async () => {
    const { f, request, marketplace } = await prepared();
    const first = await f.services.confirmSellListCheckout(request, context, marketplace);
    const events = f.memory.allEvents.length;
    const writes = [marketplace.acceptOfferMatch, marketplace.createListing, marketplace.publishListing].map(
      (fn) => fn.mock.calls.length,
    );
    f.setLines([]);
    f.setPayout("restricted");
    for (const services of [f.services, createCheckoutSellListRuntime(f.deps)]) {
      await expect(services.confirmSellListCheckout(request, context, marketplace)).resolves.toEqual(first);
      await expect(services.getConfirmation("acc_seller", request.confirmationId)).resolves.toEqual(first.confirmation);
    }
    expect(f.memory.allEvents).toHaveLength(events);
    expect(
      [marketplace.acceptOfferMatch, marketplace.createListing, marketplace.publishListing].map(
        (fn) => fn.mock.calls.length,
      ),
    ).toEqual(writes);
  });

  it("records a partial-only confirmation without completing its remaining Sell List line", async () => {
    const f = checkoutOwnerRuntimeFixture();
    const line = { ...fixtureLine, line_type: "product" as const, offer_id: null, listing_id: null, quantity: 3 };
    f.setLines([line]);
    await seedSellListAggregate(f.services, [line], f.memory.allEvents);
    const readiness = await prepareSellerConfirmation(f.services, "slc_partial", context, {
      lines: [
        {
          lineId: line.line_id,
          productOffers: [{ offerId: "off_fixture", feeQuoteFingerprint: "quote" }],
          fallbackListing: {
            inventoryItemId: "inv_partial",
            priceAmount: "10.00",
            priceCurrencyCode: "USD",
            quantityCap: "1",
          },
        },
      ],
    });
    const request = {
      sellerAccountId: "acc_seller" as never,
      confirmationId: "slc_partial",
      ...choices,
      readinessSnapshotId: readiness.snapshotId,
      readinessSourceRevision: readiness.sourceRevision,
      readinessDecisions: readiness.decisions,
    };
    const marketplace = marketplaceHandoffFixture();
    const result = await f.services.confirmSellListCheckout(request, context, marketplace);
    expect(result.completedLineIds).toEqual([]);
    const event = f.memory.allEvents.find((event) => event.eventType === "checkout.sell-list.checkout-confirmed")!;
    expect(event.payload).toMatchObject({
      completedLineIds: [],
      remainingLineQuantities: [{ lineId: line.line_id, quantity: 1 }],
      handoffSummary: { lineOutcomes: [expect.objectContaining({ status: "partial", remainingQuantity: 1 })] },
    });
    const count = f.memory.allEvents.length;
    await expect(f.services.confirmSellListCheckout(request, context, marketplace)).resolves.toEqual(result);
    expect(f.memory.allEvents).toHaveLength(count);
    expect(marketplace.acceptOfferMatch).toHaveBeenCalledOnce();
    expect(marketplace.createListing).toHaveBeenCalledOnce();
    expect(marketplace.publishListing).toHaveBeenCalledOnce();
  });

  it("confirmation changed hash conflicts", async () => {
    const { f, request, marketplace } = await prepared();
    await f.services.confirmSellListCheckout(request, context, marketplace);
    const events = f.memory.allEvents.length;
    await expect(
      f.services.confirmSellListCheckout(
        { ...request, label: { preference: "seller-label-later" } },
        context,
        marketplace,
      ),
    ).rejects.toMatchObject({ code: "checkout_confirmation_changed" });
    expect(f.memory.allEvents).toHaveLength(events);
    expect(marketplace.acceptOfferMatch).toHaveBeenCalledTimes(3);
  });

  it.each(["missing", "foreign", "stale", "unresolved"])(
    "invalid stored plan cannot start Marketplace handoff: %s",
    async (kind) => {
      const { f, request, marketplace } = await prepared();
      if (kind === "unresolved") f.setPayout("restricted");
      const invalid = {
        ...request,
        ...(kind === "missing" ? { confirmationId: "slc_missing" } : {}),
        ...(kind === "foreign" ? { sellerAccountId: "acc_foreign" as never } : {}),
        ...(kind === "stale" ? { readinessSnapshotId: "stale" } : {}),
      };
      const events = f.memory.allEvents.length;
      await expect(f.services.confirmSellListCheckout(invalid, context, marketplace)).rejects.toThrow();
      expect(marketplace.acceptOfferMatch).not.toHaveBeenCalled();
      expect(marketplace.createListing).not.toHaveBeenCalled();
      expect(marketplace.publishListing).not.toHaveBeenCalled();
      expect(f.memory.allEvents).toHaveLength(events);
    },
  );

  it("handoff refusal stops later lines", async () => {
    const { f, request, marketplace } = await prepared();
    marketplace.acceptOfferMatch.mockRejectedValueOnce(
      new marketplaceRequest.MarketplaceApiError(409, { error: { code: "fee_quote_stale" } }),
    );
    const events = f.memory.allEvents.length;
    await expect(f.services.confirmSellListCheckout(request, context, marketplace)).rejects.toMatchObject({
      reason: { recovery: { kind: "readiness-stale" } },
      lines: [
        { lineId: "sll_fixture", status: "ambiguous" },
        { lineId: "sll_match", status: "not-attempted", detail: "Not attempted." },
        { lineId: "sll_zfallback", status: "not-attempted", detail: "Not attempted." },
      ],
    });
    expect(marketplace.acceptOfferMatch).toHaveBeenCalledTimes(1);
    expect(marketplace.createListing).not.toHaveBeenCalled();
    expect(f.memory.allEvents).toHaveLength(events);
  });
});

describe("durable API-owned review plans", () => {
  const selections = { lines: [{ lineId: fixtureLine.line_id, selectedOfferFeeQuoteFingerprint: "quote" }] };
  it("retrieves the bound plan after constructing a fresh runtime over the same store", async () => {
    const f = checkoutOwnerRuntimeFixture();
    const issued = await f.services.createReviewReadiness({ sellerAccountId: "acc_seller", selections }, context);
    const fresh = createCheckoutSellListRuntime(f.deps);
    await expect(
      fresh.getReviewReadiness({
        sellerAccountId: "acc_seller",
        snapshotId: issued.readiness.snapshotId,
        sourceRevision: issued.readiness.sourceRevision,
      }),
    ).resolves.toEqual(issued);
    expect(issued.reviewPlan.lines[0]!.selectedOffer).toEqual({
      offerId: "off_fixture",
      listingId: "lst_fixture",
      feeQuoteFingerprint: "quote",
    });
    const replay = await fresh.createReviewReadiness({ sellerAccountId: "acc_seller", selections }, context);
    expect(replay).toEqual(issued);
    expect(f.memory.allEvents.filter((event) => event.eventType === "checkout.sell-list.review-planned")).toHaveLength(
      1,
    );
  });

  it.each(["missing", "foreign", "revision", "stale"])("refuses %s plans", async (kind) => {
    const f = checkoutOwnerRuntimeFixture();
    const issued = await f.services.createReviewReadiness({ sellerAccountId: "acc_seller", selections }, context);
    if (kind === "stale") f.setLines([{ ...fixtureLine, quantity: 2 }]);
    await expect(
      f.services.getReviewReadiness({
        sellerAccountId: kind === "foreign" ? "acc_other" : "acc_seller",
        snapshotId: kind === "missing" ? "missing" : issued.readiness.snapshotId,
        sourceRevision: kind === "revision" ? "wrong" : issued.readiness.sourceRevision,
      }),
    ).rejects.toThrow("Sell List readiness snapshot is stale.");
  });

  it("does not alias same-action allocations with different targets", async () => {
    const f = checkoutOwnerRuntimeFixture();
    f.setLines([{ ...fixtureLine, line_type: "product", offer_id: null, listing_id: null }]);
    const issue = (inventoryItemId: string) =>
      f.services.createReviewReadiness(
        {
          sellerAccountId: "acc_seller",
          selections: {
            lines: [
              {
                lineId: fixtureLine.line_id,
                fallbackListing: { inventoryItemId, priceAmount: "10.00", priceCurrencyCode: "USD" },
              },
            ],
          },
        },
        context,
      );
    const a = await issue("inv_a");
    const b = await issue("inv_b");
    expect(a.decisions).toEqual(b.decisions);
    expect(a.readiness.sourceRevision).toBe(b.readiness.sourceRevision);
    expect(a.readiness.snapshotId).not.toBe(b.readiness.snapshotId);
    const fresh = createCheckoutSellListRuntime(f.deps);
    for (const issued of [a, b])
      await expect(
        fresh.getReviewReadiness({
          sellerAccountId: "acc_seller",
          snapshotId: issued.readiness.snapshotId,
          sourceRevision: issued.readiness.sourceRevision,
        }),
      ).resolves.toEqual(issued);
  });

  it("preparation retains allocation and refuses a changed review identity", async () => {
    const f = checkoutOwnerRuntimeFixture();
    await seedSellListAggregate(f.services, [fixtureLine], f.memory.allEvents);
    const issued = await f.services.createReviewReadiness({ sellerAccountId: "acc_seller", selections }, context);
    const request = {
      sellerAccountId: "acc_seller",
      confirmationId: "slc_review",
      ...choices,
      entryReadinessSnapshotId: issued.readiness.snapshotId,
      entryReadinessSourceRevision: issued.readiness.sourceRevision,
    };
    await f.services.createReadinessSnapshot(request, context);
    const fresh = createCheckoutSellListRuntime(f.deps);
    f.setOfferAvailable(false);
    await expect(
      fresh.getReviewReadiness({
        sellerAccountId: "acc_seller",
        snapshotId: issued.readiness.snapshotId,
        sourceRevision: issued.readiness.sourceRevision,
        confirmationId: "slc_review",
      }),
    ).resolves.toEqual(issued);
    await expect(fresh.createReadinessSnapshot(request, context)).resolves.toMatchObject({ status: "ready" });
    const changed = await f.services.createReviewReadiness(
      {
        sellerAccountId: "acc_seller",
        selections: { lines: [{ ...selections.lines[0]!, selectedOfferFeeQuoteFingerprint: "changed" }] },
      },
      context,
    );
    await expect(
      fresh.createReadinessSnapshot(
        {
          ...request,
          entryReadinessSnapshotId: changed.readiness.snapshotId,
        },
        context,
      ),
    ).rejects.toThrow("Sell List confirmation changed.");
    expect(
      f.memory.allEvents.filter((event) => event.eventType === "checkout.sell-list.handoff-prepared"),
    ).toHaveLength(1);
  });
  it("refuses a persisted plan whose allocation was altered", async () => {
    const f = checkoutOwnerRuntimeFixture();
    const issued = await f.services.createReviewReadiness({ sellerAccountId: "acc_seller", selections }, context);
    const eventStore: EventStore = {
      ...f.deps.eventStore,
      readStream: async (query) =>
        (await f.deps.eventStore.readStream(query)).map((event) =>
          event.eventType === "checkout.sell-list.review-planned"
            ? { ...event, payload: { ...event.payload, reviewPlan: { version: 1, lines: [] } } }
            : event,
        ),
    };
    const fresh = createCheckoutSellListRuntime({ ...f.deps, eventStore });
    await expect(
      fresh.getReviewReadiness({
        sellerAccountId: "acc_seller",
        snapshotId: issued.readiness.snapshotId,
        sourceRevision: issued.readiness.sourceRevision,
      }),
    ).rejects.toThrow("Sell List readiness snapshot is stale.");
  });
});

describe("Sell List screen read services", () => {
  it("loads account-scoped inputs and one payout read without changing plan authority", async () => {
    const f = checkoutOwnerRuntimeFixture();
    const result = await f.services.loadCompositeReview("acc_seller");
    expect(result.screen.canContinue).toBe(true);
    expect(result.offerReviews[0]?.terms).toMatchObject({ fee_quote_fingerprint: expect.any(String) });
    const payoutReads = f.db.query.mock.calls.filter(([sql]) =>
      String(sql).includes("checkout_sell_payout_readiness_pages"),
    );
    expect(payoutReads).toHaveLength(1);
    expect(payoutReads[0]?.[1]).toEqual(["acc_seller"]);
    const foreign = await f.services.loadCompositeReview("acc_foreign");
    expect(foreign.screen).toMatchObject({ lineCount: 0, canContinue: false });
    expect(foreign.offerReviews).toEqual([]);
  });

  it("does not read account inventory or payout readiness for anonymous composites", async () => {
    const f = checkoutOwnerRuntimeFixture("anon_fixture");
    const result = await f.services.loadGuestCompositeReview("anon_fixture");
    expect(result.screen.payoutReadiness).toBeNull();
    expect(result.inventoryItems).toEqual([]);
    expect(f.db.query.mock.calls.every(([sql]) => !/payout_readiness|inventory_items/.test(String(sql)))).toBe(true);
    f.db.query.mockClear();
    expect((await f.services.loadGuestCompositeReview(null)).screen.lineCount).toBe(0);
    expect(f.db.query).not.toHaveBeenCalled();
  });
});
