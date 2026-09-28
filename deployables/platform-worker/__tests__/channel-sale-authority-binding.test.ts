import { expect, it, vi } from "vitest";
import * as inventory from "@chase-sets/inventory/server";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPlatformChannelSaleRecorder } from "../src/channels-reconciliation-runners";

it("passes the fixed Inventory consumer resolver to the incoming-sale writer without manufacturing a seller principal", async () => {
  const pool = {} as PgTransactionalPool;
  const consumer: inventory.InventoryListingAuthorityConsumer = vi.fn();
  const record = vi.fn(async () => ({ status: "recorded" }));
  const create = vi
    .spyOn(inventory, "createInventoryExternalChannelSaleRecorderForPool")
    .mockReturnValue(record as never);
  const command = { accountId: "acc_synthetic" } as Parameters<inventory.RecordExternalChannelSale>[0];
  try {
    await createPlatformChannelSaleRecorder(pool, consumer)(command);
    expect(create).toHaveBeenCalledExactlyOnceWith(
      pool,
      {
        tenantId: "tnt_channels_worker",
        audit: { performedByUserId: "usr_channels_worker", forAccountId: "acc_synthetic" },
      },
      consumer,
    );
    expect(record).toHaveBeenCalledExactlyOnceWith(command);
    expect(create.mock.calls[0]![1]).not.toHaveProperty("listingAuthorityPrincipal");
  } finally {
    create.mockRestore();
  }
});
