import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { GlobalPosition } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import { describe, expect, it, vi } from "vitest";
import { decideInventoryItem, initialInventoryItemState } from "../../inventory-items/domain/domain";
import type { InventoryHoldCollisionPlan } from "../domain/domain";
import { createInventoryHoldCollisionRuntime } from "./runtime";

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) => checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, checkpoint) => {
      checkpoints.set(projectorName, checkpoint);
    },
  };
}

describe("inventory hold collision runtime", () => {
  it("recovers a committed offline sale after completion fails without appending again or leaking event fields", async () => {
    const { eventStore, readAllEvents, streams } = createInMemoryEventStore();
    const idempotencyRows = new Map<
      string,
      {
        inserted: boolean;
        command_fingerprint: string;
        status: "in_progress" | "completed";
        result_item_id: string | null;
        result_version: number | null;
        result_collision: InventoryHoldCollisionPlan | null;
        created_at: string;
      }
    >();
    let failNextIdempotencyComplete = true;
    let releaseCount = 0;
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("WITH inserted AS")) {
          const key = String(values[0]);
          const existing = idempotencyRows.get(key);
          if (existing) {
            return { rows: [{ ...existing, inserted: false }], rowCount: 1 };
          }
          const row = {
            inserted: true,
            command_fingerprint: String(values[3]),
            status: "in_progress" as const,
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
              result_collision: JSON.parse(String(values[4])) as InventoryHoldCollisionPlan,
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
                quantity: 1,
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
    const services = createInventoryHoldCollisionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const request = {
      accountId: "acc_seller",
      itemId: "inv_1",
      requestedQuantity: 3,
      reason: "Offline sale",
      mode: "protect-orders" as const,
      offlineSale: {
        idempotencyKey: "offline-sale-completion-recovery",
        salePriceAmount: "125.00",
        channel: "card-show" as const,
      },
    };

    await expect(services.reduceItem(request, context)).rejects.toThrow("ledger complete failed");
    expect(idempotencyRows.get(request.offlineSale.idempotencyKey)?.status).toBe("in_progress");
    expect(releaseCount).toBe(0);

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
    expect(releaseCount).toBe(0);
  });
});
