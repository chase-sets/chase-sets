import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { GlobalPosition } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import { describe, expect, it, vi } from "vitest";
import { inventoryAdjustmentCommandFingerprint } from "../../../support/runtime-support/inventory-adjustment-idempotency";
import { decideInventoryItem, initialInventoryItemState } from "../../inventory-items/domain/domain";
import type { InventoryHoldCollisionPlan } from "../domain/domain";
import { createInventoryHoldCollisionRuntime } from "./runtime";

type IdempotencyRow = {
  inserted: boolean;
  command_fingerprint: string;
  status: "in_progress" | "completed";
  result_item_id: string | null;
  result_version: number | null;
  result_collision: InventoryHoldCollisionPlan | null;
  created_at: string;
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

function createRecoveryHarness(
  options: Readonly<{ activeHoldQuantity?: number; failNextIdempotencyComplete?: boolean }> = {},
) {
  const { eventStore, readAllEvents, streams } = createInMemoryEventStore();
  const idempotencyRows = new Map<string, IdempotencyRow>();
  let failNextIdempotencyComplete = options.failNextIdempotencyComplete ?? false;
  let releaseCount = 0;
  const db = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes("WITH inserted AS")) {
        const key = String(values[0]);
        const existing = idempotencyRows.get(key);
        if (existing) {
          return { rows: [{ ...existing, inserted: false }], rowCount: 1 };
        }
        const row: IdempotencyRow = {
          inserted: true,
          command_fingerprint: String(values[3]),
          status: "in_progress",
          result_item_id: null,
          result_version: null,
          result_collision: null,
          created_at: "2026-01-01T00:00:00.000Z",
        };
        idempotencyRows.set(key, row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("UPDATE inventory_item_adjustment_idempotency")) {
        if (failNextIdempotencyComplete) {
          failNextIdempotencyComplete = false;
          throw new Error("ledger complete failed");
        }
        const key = String(values[0]);
        const existing = idempotencyRows.get(key);
        const completed = existing?.status === "in_progress" && existing.command_fingerprint === String(values[1]);
        if (completed && existing) {
          idempotencyRows.set(key, {
            ...existing,
            inserted: false,
            status: "completed",
            result_item_id: String(values[2]),
            result_version: Number(values[3]),
            result_collision: JSON.parse(String(values[4])) as InventoryHoldCollisionPlan | null,
          });
        }
        return { rows: [], rowCount: completed ? 1 : 0 };
      }
      if (sql.includes("DELETE FROM inventory_item_adjustment_idempotency")) {
        releaseCount += 1;
        idempotencyRows.delete(String(values[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("event_type = 'inventory.hold-collision-recorded'")) {
        return {
          rows: readAllEvents()
            .filter((event) => event.eventType === "inventory.hold-collision-recorded")
            .map((event) => ({ payload: event.payload })),
        };
      }
      if (sql.includes("WITH placed AS")) {
        return {
          rows: [
            {
              hold_id: "hld_manual",
              quantity: options.activeHoldQuantity ?? 1,
              purpose: "manual",
              source_ref: null,
              committed_at: "2026-08-26T12:00:00.000Z",
            },
          ],
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    }),
  };
  const context = {
    tenantId: "tnt_inventory" as never,
    audit: {
      performedByUserId: "usr_seller" as never,
      forAccountId: "acc_seller" as never,
    },
  };
  const request = (idempotencyKey: string, requestedQuantity = 3) => ({
    accountId: "acc_seller",
    itemId: "inv_1",
    requestedQuantity,
    reason: "Offline sale",
    mode: "protect-orders" as const,
    offlineSale: {
      idempotencyKey,
      salePriceAmount: "125.00",
      channel: "card-show" as const,
    },
  });
  const seedItem = async () => {
    const [created] = decideInventoryItem(initialInventoryItemState, {
      type: "CreateInventoryItem",
      itemId: "inv_1" as never,
      accountId: "acc_seller" as never,
      catalogItemId: "cat_1" as never,
      productId: "cat_1::" as never,
      selectedOptions: [],
      storageLocationId: "loc_1",
      totalQuantity: 3,
      acquisitionCostAmount: "75.00",
    });
    await eventStore.appendToStream({
      streamId: "inventory.item-inv_1",
      expectedVersion: "no_stream",
      context,
      events: [{ eventType: created!.type, payload: created!.data }],
    });
  };
  const seedInProgressClaim = (idempotencyKey: string, requestedQuantity = 3) => {
    idempotencyRows.set(idempotencyKey, {
      inserted: true,
      command_fingerprint: inventoryAdjustmentCommandFingerprint({
        accountId: "acc_seller",
        itemId: "inv_1",
        quantityDelta: -requestedQuantity,
        reason: "Offline sale",
        reasonCode: "sold-offline",
        note: undefined,
        sourceRef: null,
        salePriceAmount: "125.00",
        channel: "card-show",
        collisionMode: "protect-orders",
      }),
      status: "in_progress",
      result_item_id: null,
      result_version: null,
      result_collision: null,
      created_at: "2026-01-01T00:00:00.000Z",
    });
  };
  const createServices = (store = eventStore) =>
    createInventoryHoldCollisionRuntime({
      eventStore: store,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

  return {
    context,
    createServices,
    eventStore,
    idempotencyRows,
    readAllEvents,
    request,
    seedInProgressClaim,
    seedItem,
    streams,
    get releaseCount() {
      return releaseCount;
    },
  };
}

function adjustedEvent(idempotencyKey: string, quantity: number) {
  return {
    eventType: "inventory.item.adjusted",
    payload: {
      itemId: "inv_1",
      quantityDelta: -quantity,
      reason: "Offline sale",
      reasonCode: "sold-offline",
      sourceRef: null,
      csatOutcomeFact: { idempotencyKey },
    },
  };
}

function offlineSaleEvent(quantity: number) {
  return {
    eventType: "inventory.item.offline-sale-recorded",
    payload: {
      itemId: "inv_1",
      quantity,
      salePriceAmount: "125.00",
      channel: "card-show",
      storageLocationId: "loc_1",
      acquisitionCostAmount: "75.00",
      recordedAt: "2026-08-27T12:00:00.000Z",
    },
  };
}

describe("inventory hold collision runtime", () => {
  it("recovers a committed offline sale after completion fails without appending again or leaking event fields", async () => {
    const harness = createRecoveryHarness({ failNextIdempotencyComplete: true });
    const { context, idempotencyRows, readAllEvents, streams } = harness;
    await harness.seedItem();
    const services = harness.createServices();
    const request = harness.request("offline-sale-completion-recovery");

    await expect(services.reduceItem(request, context)).rejects.toThrow("ledger complete failed");
    expect(idempotencyRows.get(request.offlineSale.idempotencyKey)?.status).toBe("in_progress");
    expect(harness.releaseCount).toBe(0);

    const rawCollision = readAllEvents().find((event) => event.eventType === "inventory.hold-collision-recorded")
      ?.payload as Record<string, unknown>;
    expect(rawCollision).toHaveProperty("collisionId");
    expect(rawCollision).toHaveProperty("totalQuantityAfter");

    const recovered = await services.reduceItem(request, context);
    expect(recovered).toMatchObject({
      itemId: "inv_1",
      version: 3,
      requestedQuantity: 3,
      appliedQuantity: 2,
      refusedQuantity: 1,
    });
    const collisionKeys = [
      "mode",
      "authorizedByRole",
      "requestedQuantity",
      "appliedQuantity",
      "refusedQuantity",
      "heldQuantity",
      "availableQuantity",
      "releasedHoldQuantity",
      "affectedOrders",
    ];
    expect(Object.keys(recovered.collision!)).toEqual(collisionKeys);
    expect(Object.keys(idempotencyRows.get(request.offlineSale.idempotencyKey)!.result_collision!)).toEqual(
      collisionKeys,
    );
    expect(
      streams
        .get("inventory.item-inv_1")
        ?.filter((event) => event.eventType === "inventory.item.offline-sale-recorded"),
    ).toHaveLength(1);
    expect(readAllEvents().filter((event) => event.eventType === "inventory.hold-collision-recorded")).toHaveLength(1);
    expect(harness.releaseCount).toBe(0);
  });

  it("does not adopt a different key's otherwise identical offline sale", async () => {
    const harness = createRecoveryHarness();
    await harness.seedItem();
    harness.seedInProgressClaim("first-sale");
    const services = harness.createServices();

    await expect(services.reduceItem(harness.request("second-sale"), harness.context)).resolves.toMatchObject({
      version: 3,
      appliedQuantity: 2,
      refusedQuantity: 1,
    });
    const eventCount = harness.readAllEvents().length;

    await expect(services.reduceItem(harness.request("first-sale"), harness.context)).rejects.toThrow(
      "Inventory adjustment idempotency key is already being processed.",
    );

    expect(harness.idempotencyRows.get("first-sale")).toMatchObject({
      status: "in_progress",
      result_item_id: null,
      result_version: null,
    });
    expect(harness.readAllEvents()).toHaveLength(eventCount);
    expect(
      harness.readAllEvents().filter((event) => event.eventType === "inventory.item.offline-sale-recorded"),
    ).toHaveLength(1);
    expect(harness.releaseCount).toBe(0);
  });

  it("preserves zero-applied recovery from durable stock-authority evidence", async () => {
    const harness = createRecoveryHarness({ activeHoldQuantity: 3, failNextIdempotencyComplete: true });
    await harness.seedItem();
    const idempotencyKey = "zero-applied-sale";
    const services = harness.createServices();

    await expect(services.reduceItem(harness.request(idempotencyKey), harness.context)).rejects.toThrow(
      "ledger complete failed",
    );
    const eventCount = harness.readAllEvents().length;

    await expect(services.reduceItem(harness.request(idempotencyKey), harness.context)).resolves.toMatchObject({
      itemId: "inv_1",
      version: 2,
      requestedQuantity: 3,
      appliedQuantity: 0,
      refusedQuantity: 3,
    });
    expect(harness.readAllEvents()).toHaveLength(eventCount);
    expect(
      harness.readAllEvents().filter((event) => event.eventType === "inventory.item.offline-sale-recorded"),
    ).toHaveLength(0);
    expect(harness.idempotencyRows.get(idempotencyKey)?.status).toBe("completed");
    expect(harness.releaseCount).toBe(0);
  });

  it.each([
    ["a missing following sale event", (idempotencyKey: string) => [adjustedEvent(idempotencyKey, 1)]],
    [
      "a non-adjacent keyed event pair",
      (idempotencyKey: string) => [
        adjustedEvent(idempotencyKey, 1),
        {
          eventType: "inventory.item.stock-authority-claimed",
          payload: {
            itemId: "inv_1",
            authorityRef: "intervening-event",
            operation: "stock-reduction",
            quantity: 1,
          },
        },
        offlineSaleEvent(1),
      ],
    ],
    [
      "an invalid adjacent sale event",
      (idempotencyKey: string) => [adjustedEvent(idempotencyKey, 1), offlineSaleEvent(2)],
    ],
    [
      "ambiguous keyed event pairs",
      (idempotencyKey: string) => [
        adjustedEvent(idempotencyKey, 1),
        offlineSaleEvent(1),
        adjustedEvent(idempotencyKey, 1),
        offlineSaleEvent(1),
      ],
    ],
  ])("leaves the claim in progress for %s", async (_name, buildEvents) => {
    const harness = createRecoveryHarness();
    await harness.seedItem();
    const idempotencyKey = "poisoned-sale";
    harness.seedInProgressClaim(idempotencyKey, 1);
    await harness.eventStore.appendToStream({
      streamId: "inventory.item-inv_1",
      expectedVersion: 1,
      context: harness.context,
      events: buildEvents(idempotencyKey),
    });
    const eventCount = harness.readAllEvents().length;

    await expect(
      harness.createServices().reduceItem(harness.request(idempotencyKey, 1), harness.context),
    ).rejects.toThrow("Inventory adjustment idempotency key is already being processed.");

    expect(harness.idempotencyRows.get(idempotencyKey)).toMatchObject({
      status: "in_progress",
      result_item_id: null,
      result_version: null,
    });
    expect(harness.readAllEvents()).toHaveLength(eventCount);
    expect(harness.releaseCount).toBe(0);
  });

  it("leaves the claim in progress when a keyed pair reports a mismatched stream", async () => {
    const harness = createRecoveryHarness();
    await harness.seedItem();
    const idempotencyKey = "mismatched-stream-sale";
    harness.seedInProgressClaim(idempotencyKey, 1);
    await harness.eventStore.appendToStream({
      streamId: "inventory.item-inv_1",
      expectedVersion: 1,
      context: harness.context,
      events: [adjustedEvent(idempotencyKey, 1), offlineSaleEvent(1)],
    });
    const mismatchedStore = {
      ...harness.eventStore,
      readStream: async (input: Parameters<typeof harness.eventStore.readStream>[0]) =>
        (await harness.eventStore.readStream(input)).map((event) =>
          event.eventType === "inventory.item.adjusted"
            ? { ...event, streamId: "inventory.item-other" as never }
            : event,
        ),
    };

    await expect(
      harness.createServices(mismatchedStore).reduceItem(harness.request(idempotencyKey, 1), harness.context),
    ).rejects.toThrow("Inventory adjustment idempotency key is already being processed.");

    expect(harness.idempotencyRows.get(idempotencyKey)?.status).toBe("in_progress");
    expect(harness.releaseCount).toBe(0);
  });
});
