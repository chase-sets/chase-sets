import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { PgPoolClient, PgTransactionalPool, PostgresEventStore } from "@chase-sets/event-core-postgres";
import { createInventoryDraftListingConsumer } from "./inventory-draft-consumer";
import { createMarketplaceListingRuntime } from "./runtime";
import { draftContext, draftMessage, draftProductMeasure } from "../tests/issue-7169-c4-fixture";

const recordedCard = {
  gradingCompany: "PSA",
  grade: "Gem Mint 10",
  certificationNumber: null,
  population: null,
  conditionDescriptors: [],
};

function fixture(answer: typeof recordedCard | null | Error) {
  const message = draftMessage();
  const { snapshot } = message;
  const memory = createInMemoryEventStore();
  let gradedCard: unknown;
  let selectedOptions: unknown;
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql.includes("AS ready")) return { rows: [{ ready: true }] };
    if (sql.includes("SELECT current_version FROM event_store_streams")) {
      const events = await memory.eventStore.readStream({ streamId: String(values[0]) });
      return { rows: events.length ? [{ current_version: events.at(-1)!.streamVersion }] : [] };
    }
    if (sql.includes("INSERT INTO marketplace_supply_locations")) {
      return { rows: [{ storage_location_id: snapshot.storageLocationId }] };
    }
    if (sql.includes("INSERT INTO marketplace_supply_items")) {
      selectedOptions = JSON.parse(String(values[4]));
      gradedCard = typeof values[5] === "string" ? JSON.parse(values[5]) : null;
      return { rows: [{ item_id: snapshot.inventoryItemId }] };
    }
    if (sql.includes("FROM marketplace_supply_items AS item")) {
      return {
        rows: [
          {
            item_id: snapshot.inventoryItemId,
            account_id: message.authority.accountId,
            catalog_catalog_item_id: snapshot.catalogItemId,
            product_id: snapshot.productId,
            selected_options: selectedOptions,
            product_measure_snapshot: draftProductMeasure(),
            graded_card: gradedCard,
            storage_location_name: snapshot.storageLocationName,
            ship_from_code: snapshot.shipFromCode,
            ship_from_address: snapshot.shipFromAddress,
            available_quantity: snapshot.totalQuantity,
          },
        ],
      };
    }
    return { rows: [] };
  });
  const client = { query, release: vi.fn() } as PgPoolClient;
  const pool = { query, connect: async () => client } as PgTransactionalPool;
  const eventStore: PostgresEventStore = {
    ...memory.eventStore,
    readStreamInTransaction: (_client, input) => memory.eventStore.readStream(input),
    appendToStreamInTransaction: (_client, input) => memory.eventStore.appendToStream(input),
    appendToStreamsInTransaction: (_client, inputs) => memory.eventStore.appendToStreams!(inputs),
  };
  const resolve = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return { gradedCard: answer, selectedOptions: [] };
  });
  const consumer = createInventoryDraftListingConsumer({
    pool,
    eventStore,
    createListings: (db, transactionalEventStore) =>
      createMarketplaceListingRuntime({
        db,
        eventStore: transactionalEventStore,
        checkpointStore: {
          loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
          saveCheckpoint: async () => {},
        },
        inventoryItemGradedCardAuthority: { resolve },
        commercialTermsResolver: {
          resolveListingTerms: async ({ accountId, amount }: { accountId: string; amount: string }) => ({
            accountId,
            accountType: "business",
            basisAmount: amount,
            marketplaceSalesFeeUnitAmount: "0.00",
            sellerNetUnitAmount: amount,
            scheduleId: "cts_batch",
            agreementId: null,
            resolvedAt: snapshot.committedAt,
          }),
        } as never,
      }),
  });
  return { consumer, message, resolve, query, allEvents: memory.allEvents };
}

function acceptedDraft(f: ReturnType<typeof fixture>) {
  return f.allEvents.find((event) => event.eventType === "marketplace.listing.created")?.payload;
}

describe("Inventory import draft grading", () => {
  it("accepts a graded draft with the recorded company and grade, no number, and the message selection", async () => {
    const f = fixture(recordedCard);
    await expect(f.consumer.accept(f.message, draftContext)).resolves.toMatchObject({
      source: "message",
      listingVersion: 1,
    });
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith({ accountId: "acc_c4", inventoryItemId: "inv_c4" });
    expect(acceptedDraft(f)).toMatchObject({
      gradedCard: recordedCard,
      selectedOptions: f.message.snapshot.selectedOptions,
    });
  });

  it("accepts an ungraded draft with a null graded card", async () => {
    const f = fixture(null);
    await expect(f.consumer.accept(f.message, draftContext)).resolves.toMatchObject({
      source: "message",
      listingVersion: 1,
    });
    expect(acceptedDraft(f)).toMatchObject({ gradedCard: null });
  });

  it("returns a retryable failure without creating a draft when the Inventory read fails", async () => {
    const f = fixture(new Error("Inventory unavailable"));
    await expect(f.consumer.accept(f.message, draftContext)).rejects.toMatchObject({
      code: "inventory-draft-unavailable",
    });
    expect(f.allEvents).toEqual([]);
    expect(f.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO marketplace_supply_items"))).toBe(false);
  });
});
