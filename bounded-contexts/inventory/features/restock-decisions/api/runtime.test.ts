import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createRestockDecisionRuntime } from "./runtime";
import type { InventoryItemServices } from "../../inventory-items/api/runtime";

const context = {
  tenantId: "tnt_inventory" as never,
  audit: {
    performedByUserId: "usr_seller" as never,
    forAccountId: "acc_seller" as never,
  },
};

function checkpointStore(): ProjectionCheckpointStore {
  return {
    loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
    saveCheckpoint: async () => undefined,
  };
}

describe("restock decision runtime", () => {
  it("uses return-restocked only for restocked stock and emits no adjustment for written-off", async () => {
    const { eventStore, streams } = createInMemoryEventStore();
    const adjustItem = vi.fn<InventoryItemServices["adjustItem"]>(async (params) => ({
      itemId: params.itemId,
      version: 2,
    }));
    const services = createRestockDecisionRuntime(
      {
        eventStore,
        checkpointStore: checkpointStore(),
        db: { query: vi.fn(async () => ({ rows: [] })) } as never,
      },
      { adjustItem } as unknown as InventoryItemServices,
      { projectors: [] } as never,
    );
    const restocked = await services.markPending(
      {
        accountId: "acc_seller",
        orderId: "ord_restocked",
        itemId: "inv_restocked",
        quantity: 2,
        reservationRequestId: "rsv_restocked",
        source: "shipment-returned",
        pendingAt: "2026-08-19T00:00:00.000Z",
      },
      context,
    );
    const writtenOff = await services.markPending(
      {
        accountId: "acc_seller",
        orderId: "ord_written_off",
        itemId: "inv_written_off",
        quantity: 1,
        reservationRequestId: "rsv_written_off",
        source: "shipment-returned",
        pendingAt: "2026-08-19T00:00:00.000Z",
      },
      context,
    );

    await services.recordDecision(
      { accountId: "acc_seller", decisionId: restocked.decisionId, outcome: "restocked" },
      context,
    );
    await services.recordDecision(
      { accountId: "acc_seller", decisionId: writtenOff.decisionId, outcome: "written-off" },
      context,
    );

    expect(adjustItem).toHaveBeenCalledTimes(1);
    expect(adjustItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "inv_restocked",
        quantityDelta: 2,
        reason: "return-restocked",
        reasonCode: "return-restocked",
      }),
      context,
    );
    expect(streams.get(`inventory.restock-decision-${writtenOff.decisionId}`)?.map((event) => event.eventType)).toEqual(
      ["inventory.restock-decision.pending", "inventory.restock-decision.recorded"],
    );
  });
});
