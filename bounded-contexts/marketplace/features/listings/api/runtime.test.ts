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
import { createMarketplaceListingRuntime } from "./runtime";

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
    loadCheckpoint: async (projectorName) =>
      checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
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

describe("marketplace listing runtime", () => {
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
                storage_location_name: "North shelf",
                ship_from_code: "CHI",
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
          marketplaceFeeAmount: "1.00",
          paymentFeeAmount: "0.50",
          sellerNetAmount: "18.50",
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

    await expect(
      services.publishListing(
        {
          accountId: "acc_seller",
          listingId: "lst_seed_1",
        },
        context,
      ),
    ).resolves.toEqual({
      listingId: "lst_seed_1",
      version: 2,
    });
  });
});
