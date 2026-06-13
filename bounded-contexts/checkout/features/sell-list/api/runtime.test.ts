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
  return {
    query: vi.fn(async (query: unknown) => {
      const sql = String(query);
      if (sql.includes("checkout_sell_list_confirmation_pages")) {
        return { rows: [] };
      }
      if (sql.includes("checkout_sell_list_line_pages")) {
        return { rows: lines };
      }
      return { rows: [] };
    }),
  };
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
});
