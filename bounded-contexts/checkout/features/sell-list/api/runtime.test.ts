import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
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
import type { CheckoutSellListLineRow } from "../read-model/queries";
import { createCheckoutSellListRuntime } from "./runtime";

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

function createInMemoryEventStore() {
  let globalPosition = 0;
  const streams = new Map<string, StoredEvent[]>();
  const allEvents: StoredEvent[] = [];

  const eventStore: EventStore = {
    appendToStream: async (input: AppendToStreamInput) => {
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
    },
    readStream: async (input: ReadStreamInput) =>
      [...(streams.get(input.streamId) ?? [])].slice((input.fromVersion ?? 1) - 1),
    readAll: async (input?: ReadAllInput) => {
      const after = Number(input?.afterGlobalPosition ?? ZERO_GLOBAL_POSITION);
      return allEvents.filter((event) => Number(event.globalPosition) > after);
    },
  };

  return { allEvents, eventStore };
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

function createDb(lines: readonly CheckoutSellListLineRow[]) {
  let sellListLines = [...lines];
  const db = {
    query: vi.fn(async (query: unknown, params?: readonly unknown[]) => {
      const sql = String(query);
      if (sql.includes("checkout_sell_list_confirmation_pages")) {
        return { rows: [] };
      }
      if (sql.includes("checkout_sell_list_line_pages")) {
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
  conditionReview: {
    status: "accepted",
    acceptedAt: "2026-06-09T00:00:00.000Z",
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
    const readiness = createSellListReadinessSnapshot([selectedOfferLine, productLine]);
    const { allEvents, eventStore } = createInMemoryEventStore();
    const services = createCheckoutSellListRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createDb([selectedOfferLine, productLine]) as never,
    });
    await seedSellListAggregate(services, [selectedOfferLine, productLine], allEvents);

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
    const readiness = createSellListReadinessSnapshot([productLine], {
      lineActions: [{ lineId: "sll_product", action: "smart-match" }],
    });
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

  it("prunes projected Sell List rows that are absent from the aggregate", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = createDb([productLine]);
    const services = createCheckoutSellListRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await expect(services.listLines("acc_seller")).resolves.toEqual([]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM checkout_sell_list_line_pages"), [
      "acc_seller",
      ["sll_product"],
    ]);
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
    ).resolves.toEqual({ mergedLineCount: 1 });

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
