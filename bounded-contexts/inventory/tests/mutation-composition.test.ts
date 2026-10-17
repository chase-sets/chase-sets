import { describe, expect, it, vi } from "vitest";
import { createInventoryServices } from "../support/runtime-support/services";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";

describe("issue-7169-c1-boundary-recovery: production composition", () => {
  it("requires a caller attempt before any cut-over service can query or write", async () => {
    const query = vi.fn(async () => {
      throw new Error("unfenced query");
    });
    const pool: PgTransactionalPool = { query, connect: async () => ({ query, release: vi.fn() }) };
    const services = createInventoryServices(pool);
    const context = {
      tenantId: "tnt_test",
      audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
    } as const;
    const calls = [
      () =>
        services.items.createItem(
          {
            accountId: "acc_test" as never,
            catalogItemId: "cat_test",
            selectedOptions: [],
            storageLocationId: "loc_test",
            totalQuantity: 1,
          },
          context,
        ),
      () =>
        services.items.adjustItem(
          { accountId: "acc_test", itemId: "inv_test", quantityDelta: 1, reason: "Intake" },
          context,
        ),
      () =>
        services.items.ensureListingStock(
          { accountId: "acc_test" as never, catalogItemId: "cat_test", selectedOptions: [], quantity: 1 },
          context,
        ),
      () =>
        services.holdCollisions.reduceItem(
          {
            accountId: "acc_test",
            itemId: "inv_test",
            requestedQuantity: 1,
            reason: "Reduction",
            mode: "protect-orders",
            actorRole: "owner",
          },
          context,
        ),
      () =>
        services.holds.createHold(
          {
            accountId: "acc_test" as never,
            itemId: "inv_test",
            quantity: 1,
            reason: "Manual",
            purpose: "manual",
            sourceRef: null,
          },
          context,
        ),
      () => services.holds.releaseHold({ accountId: "acc_test", holdId: "hld_test", releaseReason: "manual" }, context),
      () =>
        services.storageLocations.updateStorageLocation(
          {
            accountId: "acc_test",
            storageLocationId: "loc_test",
            name: "Test",
            shipFromCode: "TEST",
            shipFromAddress: {
              name: "Test",
              line1: "1 Test",
              city: "Test",
              state: "IL",
              postalCode: "60000",
              country: "US",
            },
          },
          context,
        ),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow("caller-created Inventory mutation attempt");
    expect(query).not.toHaveBeenCalled();
  });
});
