import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { projectInventoryAcquisitionLot } from "./acquisition-projection";

function db(rows: readonly Record<string, unknown>[] = [{ persisted_count: "1", binding_count: "1" }]) {
  const query = vi.fn(async () => ({ rows }));
  return { value: { query } as PgQueryable, query };
}

function event(data: Record<string, unknown>, streamVersion = 1) {
  return {
    id: `synthetic-event-${streamVersion}`,
    streamVersion,
    data,
    timing: { occurredAt: "2026-09-07T06:00:00Z", recordedAt: "2026-09-07T07:00:00Z" },
  };
}

describe("Inventory acquisition lot projection adapter", () => {
  it("projects seller-supplied create occurrence without substituting recorded time", async () => {
    const target = db();
    await projectInventoryAcquisitionLot(
      target.value,
      event({
        itemId: "synthetic-item",
        accountId: "synthetic-owner-account",
        totalQuantity: 2,
        acquisitionOccurrence: {
          kind: "occurred",
          occurredAt: "2026-09-01T05:00:00-05:00",
          source: "seller-supplied",
        },
      }),
      "inventory.item.created",
    );
    expect(target.query.mock.calls[0]?.[1]).toEqual([
      "synthetic-owner-account",
      "synthetic-item",
      1,
      2,
      "occurred",
      "2026-09-01T05:00:00-05:00",
      "seller-supplied",
      "synthetic-event-1",
      "2026-09-07T07:00:00Z",
    ]);
  });

  it("projects retained missing occurrence as explicit unknown", async () => {
    const target = db();
    await projectInventoryAcquisitionLot(
      target.value,
      event({ itemId: "synthetic-item", accountId: "synthetic-owner-account", totalQuantity: 1 }),
      "inventory.item.created",
    );
    expect(target.query.mock.calls[0]?.[1]?.slice(4, 7)).toEqual(["unknown", null, null]);
  });

  it("uses the qualified Inventory item binding only for positive adjustments", async () => {
    const target = db();
    await projectInventoryAcquisitionLot(
      target.value,
      event(
        {
          itemId: "synthetic-item",
          quantityDelta: 3,
          acquisitionOccurrence: { kind: "unknown" },
        },
        4,
      ),
      "inventory.item.adjusted",
    );
    expect(target.query.mock.calls[0]?.[0]).toContain("pricing_inventory_item_inputs.seller_account_id AS account_id");

    const noWrite = db();
    await projectInventoryAcquisitionLot(
      noWrite.value,
      event({ itemId: "synthetic-item", quantityDelta: -1 }, 5),
      "inventory.item.adjusted",
    );
    expect(noWrite.query).not.toHaveBeenCalled();
  });

  it("fails closed for a missing account binding or a future occurrence", async () => {
    const missing = db([{ binding_count: "0", persisted_count: "0" }]);
    await expect(
      projectInventoryAcquisitionLot(
        missing.value,
        event({ itemId: "synthetic-item", quantityDelta: 1, acquisitionOccurrence: { kind: "unknown" } }, 2),
        "inventory.item.adjusted",
      ),
    ).rejects.toThrow(/exactly one account-qualified/);

    await expect(
      projectInventoryAcquisitionLot(
        db().value,
        event({
          itemId: "synthetic-item",
          accountId: "synthetic-owner-account",
          totalQuantity: 1,
          acquisitionOccurrence: {
            kind: "occurred",
            occurredAt: "2026-09-08T06:00:00Z",
            source: "seller-supplied",
          },
        }),
        "inventory.item.created",
      ),
    ).rejects.toThrow(/cannot be later/);
  });
});
