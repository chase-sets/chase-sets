import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
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
import { createSellListReadinessSnapshot } from "../domain/readiness";
import type { SellListConfirmationSummary, SellListSellerConfirmationEvidence } from "../domain/domain";
import { listSellListReadinessLines, type CheckoutSellListLineRow } from "../read-model/queries";
import { createCheckoutSellListRuntime } from "./runtime";

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
            catalog_catalog_item_id: String(params?.[8] ?? ""),
            product_id: String(params?.[9] ?? ""),
            item_title: String(params?.[10] ?? ""),
            item_subtitle: params?.[11] === null || params?.[11] === undefined ? null : String(params[11]),
            selected_options: projectedSelectedOptions(params?.[12]),
            product_summary: params?.[13] === null || params?.[13] === undefined ? null : String(params[13]),
            quantity: Number(params?.[14] ?? 0),
            fallback_mode: params?.[15] === "create-listing" ? "create-listing" : "none",
            minimum_listing_price_amount:
              params?.[16] === null || params?.[16] === undefined ? null : String(params[16]),
            created_at: String(params?.[17] ?? ""),
            updated_at: String(params?.[17] ?? ""),
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

const handoffSummary: SellListConfirmationSummary = {
  acceptedOfferCount: 1,
  publishedListingCount: 0,
  skippedLineCount: 0,
  skippedReasons: [],
  sideEffects: {
    sale: "handoff-recorded",
    label: "pending-downstream",
    payout: "pending-downstream",
    settlement: "pending-downstream",
    notification: "pending-downstream",
    accountHistory: "pending-downstream",
  },
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
    const readiness = createSellListReadinessSnapshot(
      await listSellListReadinessLines(db as never, "acc_seller"),
      null,
      sellerEvidence,
    );

    await expect(
      services.confirmSellListCheckout(
        {
          sellerAccountId: "acc_seller" as never,
          confirmationId: "slc_unresolved",
          readinessSnapshotId: readiness.snapshotId,
          readinessSourceRevision: readiness.sourceRevision,
          sellerEvidence,
          handoffSummary,
        },
        context,
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
          sellerEvidence,
          handoffSummary,
        },
        context,
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
          sellerEvidence,
          handoffSummary,
        },
        context,
      ),
    ).rejects.toThrow("Sell List readiness snapshot is stale.");

    expect(allEvents).toEqual([]);
  });

  it("rejects selected-offer confirmation when payout evidence is not ready", async () => {
    const restrictedPayoutEvidence: SellListSellerConfirmationEvidence = {
      ...sellerEvidence,
      payout: {
        ...sellerEvidence.payout,
        readinessStatus: "restricted",
      },
    };
    const readiness = createSellListReadinessSnapshot([selectedOfferLine], null, restrictedPayoutEvidence);
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
          confirmationId: "slc_restricted_payout",
          readinessSnapshotId: readiness.snapshotId,
          readinessSourceRevision: readiness.sourceRevision,
          sellerEvidence: restrictedPayoutEvidence,
          handoffSummary,
        },
        context,
      ),
    ).rejects.toThrow("Seller confirmation evidence must include payout readiness facts.");

    expect(allEvents).toEqual([]);
  });

  it("rejects product-line confirmation when seller evidence changed after readiness", async () => {
    const decisions = {
      lineActions: [{ lineId: "sll_product", action: "smart-match" as const }],
    };
    const readiness = createSellListReadinessSnapshot([productLine], decisions, sellerEvidence);
    const changedEvidence: SellListSellerConfirmationEvidence = {
      ...sellerEvidence,
      label: { status: "ready", preference: "seller-label-later" },
    };
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
          sellerEvidence: changedEvidence,
          handoffSummary,
        },
        context,
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

    expect(result).toEqual({
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
          sellerAccountId: "acc_seller" as never,
          lineType: "selected-offer",
          offerId: "off_ready",
          buyerAccountId: "acc_buyer",
          buyerDisplayName: "Jane Buyer",
          offerPriceAmount: "120.00",
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
    ).resolves.toEqual({
      lineId: "sll_offer",
      version: 1,
      status: "merged",
      commandReceipt: {
        mode: "eventual",
        commitPosition: "1",
        commitEventIds: ["evt_1"],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "1",
            eventIds: ["evt_1"],
          },
        ],
      },
    });
    expect(allEvents).toEqual([]);
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
      services.removeLine({ sellerAccountId: "acc_seller" as never, lineId: "sll_product" as never }, context),
    ).resolves.toEqual({ lineId: "sll_product", version: 0 });
    await expect(services.listLines("acc_seller")).resolves.toEqual([]);
  });
});
