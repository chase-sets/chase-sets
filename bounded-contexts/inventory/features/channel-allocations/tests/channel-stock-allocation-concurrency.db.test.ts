import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { module as inventoryModule } from "../../..";
import { channelStockAllocationStreamId } from "../domain/allocation";
import { buildInventoryChannelStockAllocationProjectionHandlers } from "../read-model/projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for Inventory Channel Stock Allocation DB tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const context: EventStoreContext = {
  tenantId: "tnt_synthetic_allocation" as never,
  audit: {
    performedByUserId: "usr_synthetic_allocation" as never,
    forAccountId: "account-synthetic" as never,
  },
};

describeDb("channel-stock-allocation-concurrency / channel-stock-allocation-poison-history", () => {
  let pools: Readonly<Record<"inventory", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let eventStore: ReturnType<typeof createPostgresEventStore>;
  let services: ReturnType<typeof inventoryModule.createServices>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["inventory"], "channel_stock_allocation");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.inventory;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pool);
    eventStore = createPostgresEventStore({ pool });
    services = inventoryModule.createServices(pool, {});
  });

  afterAll(async () => closeMultiContextTestPools(pools));

  function command(inventoryItemId: string, expectedRevision: number, units = 2) {
    return {
      accountId: "account-synthetic",
      inventoryItemId,
      mode: "partitioned" as const,
      partitions: [{ channelConnectionId: "connection-synthetic", units }],
      expectedRevision,
    };
  }

  function payload(inventoryItemId: string, overrides: Record<string, unknown> = {}) {
    return {
      eventVersion: 1,
      accountId: "account-synthetic",
      inventoryItemId,
      mode: "partitioned",
      partitions: [{ channelConnectionId: "connection-synthetic", units: 2 }],
      setAt: "2026-09-11T18:00:00.000Z",
      ...overrides,
    };
  }

  async function appendRaw(
    inventoryItemId: string,
    eventType: string,
    data: Record<string, unknown>,
    expectedVersion: number | "no_stream" = "no_stream",
  ) {
    await eventStore.appendToStream({
      streamId: channelStockAllocationStreamId(inventoryItemId),
      expectedVersion,
      events: [{ eventType, payload: data as never, occurredAt: data.setAt as never }],
      context,
    });
  }

  async function count(inventoryItemId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM event_store_events WHERE stream_id=$1",
      [channelStockAllocationStreamId(inventoryItemId)],
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  it("channel-stock-allocation-contract keeps absence compatible and applies successive absolute revisions", async () => {
    await expect(
      services.channelStockAllocations.readAuthoritative({
        accountId: "account-synthetic",
        inventoryItemId: "item-healthy",
      }),
    ).resolves.toEqual({
      accountId: "account-synthetic",
      inventoryItemId: "item-healthy",
      mode: "shared-pool",
      partitions: [],
      revision: 0,
      setAt: null,
    });

    const first = await services.channelStockAllocations.set(command("item-healthy", 0, 2), context);
    const staleBefore = await count("item-healthy");
    await expect(services.channelStockAllocations.set(command("item-healthy", 0, 9), context)).resolves.toMatchObject({
      kind: "refused",
      code: "channel-stock-allocation-revision-conflict",
      actualRevision: 1,
    });
    expect(await count("item-healthy")).toBe(staleBefore);
    const second = await services.channelStockAllocations.set(command("item-healthy", 1, 4), context);
    const third = await services.channelStockAllocations.set(
      {
        accountId: "account-synthetic",
        inventoryItemId: "item-healthy",
        mode: "shared-pool",
        partitions: [],
        expectedRevision: 2,
      },
      context,
    );
    expect(first).toMatchObject({ kind: "applied", allocation: { revision: 1, partitions: [{ units: 2 }] } });
    expect(second).toMatchObject({ kind: "applied", allocation: { revision: 2, partitions: [{ units: 4 }] } });
    expect(third).toMatchObject({ kind: "applied", allocation: { revision: 3, mode: "shared-pool", partitions: [] } });
    await expect(
      services.channelStockAllocations.readAuthoritative({
        accountId: "account-synthetic",
        inventoryItemId: "item-healthy",
      }),
    ).resolves.toMatchObject({ revision: 3, mode: "shared-pool", partitions: [] });
  });

  it("lets one of two same-revision writers win and gives the loser zero append", async () => {
    const [left, right] = await Promise.all([
      services.channelStockAllocations.set(command("item-race", 0, 2), context),
      services.channelStockAllocations.set(command("item-race", 0, 7), context),
    ]);
    expect([left, right].filter((result) => result.kind === "applied")).toHaveLength(1);
    expect(
      [left, right].filter(
        (result) => result.kind === "refused" && result.code === "channel-stock-allocation-revision-conflict",
      ),
    ).toHaveLength(1);
    expect(await count("item-race")).toBe(1);
    const final = await services.channelStockAllocations.readAuthoritative({
      accountId: "account-synthetic",
      inventoryItemId: "item-race",
    });
    expect(final).toMatchObject({ revision: 1 });
    expect([2, 7]).toContain((final as { partitions: readonly { units: number }[] }).partitions[0]?.units);
  });

  it.each([
    ["unknown-type", "synthetic.inventory-allocation", payload("item-unknown-type"), "unknown-event"],
    [
      "unsupported-version",
      "inventory.channel-stock-allocation.set",
      payload("item-unsupported-version", { eventVersion: 2 }),
      "unsupported-event-version",
    ],
    [
      "inconsistent-shared-pool",
      "inventory.channel-stock-allocation.set",
      payload("item-inconsistent-shared-pool", { mode: "shared-pool" }),
      "inconsistent-history",
    ],
    [
      "inconsistent-unsorted",
      "inventory.channel-stock-allocation.set",
      payload("item-inconsistent-unsorted", {
        partitions: [
          { channelConnectionId: "connection-z", units: 1 },
          { channelConnectionId: "connection-a", units: 1 },
        ],
      }),
      "inconsistent-history",
    ],
  ])("refuses real stored %s poison with zero append", async (itemId, eventType, data, reason) => {
    await appendRaw(itemId, eventType, data as Record<string, unknown>);
    const before = await count(itemId);
    await expect(services.channelStockAllocations.set(command(itemId, 1), context)).resolves.toMatchObject({
      kind: "refused",
      code: "channel-stock-allocation-history-invalid",
      reason,
    });
    expect(await count(itemId)).toBe(before);
  });

  it("refuses an invalid tail and a non-contiguous revision sequence with zero append", async () => {
    await appendRaw("item-invalid-tail", "inventory.channel-stock-allocation.set", payload("item-invalid-tail"));
    await appendRaw(
      "item-invalid-tail",
      "inventory.channel-stock-allocation.set",
      payload("item-invalid-tail", { unknown: true }),
      1,
    );
    const tailBefore = await count("item-invalid-tail");
    await expect(services.channelStockAllocations.set(command("item-invalid-tail", 2), context)).resolves.toMatchObject(
      {
        reason: "invalid-tail",
        eventIndex: 1,
      },
    );
    expect(await count("item-invalid-tail")).toBe(tailBefore);

    await appendRaw("item-wrong-order", "inventory.channel-stock-allocation.set", payload("item-wrong-order"));
    await appendRaw(
      "item-wrong-order",
      "inventory.channel-stock-allocation.set",
      payload("item-wrong-order", { setAt: "2026-09-11T18:01:00.000Z" }),
      1,
    );
    const streamId = channelStockAllocationStreamId("item-wrong-order");
    await pool.query("UPDATE event_store_events SET stream_version=3 WHERE stream_id=$1 AND stream_version=2", [
      streamId,
    ]);
    await pool.query("UPDATE event_store_streams SET current_version=3 WHERE stream_id=$1", [streamId]);
    const orderBefore = await count("item-wrong-order");
    await expect(services.channelStockAllocations.set(command("item-wrong-order", 3), context)).resolves.toMatchObject({
      reason: "wrong-order-or-version",
    });
    expect(await count("item-wrong-order")).toBe(orderBefore);
  });

  it("kills the tail-only history bypass mutant with an invalid prefix and valid final Set", async () => {
    const itemId = "item-invalid-prefix";
    await appendRaw(itemId, "inventory.channel-stock-allocation.set", payload(itemId, { mode: "shared-pool" }));
    await appendRaw(
      itemId,
      "inventory.channel-stock-allocation.set",
      payload(itemId, { setAt: "2026-09-11T18:01:00.000Z" }),
      1,
    );
    const tail = await eventStore.readStream({ streamId: channelStockAllocationStreamId(itemId), fromVersion: 2 });
    expect(tail).toHaveLength(1);
    expect(tail[0]?.payload).toMatchObject({ mode: "partitioned", partitions: [{ units: 2 }] });
    const before = await count(itemId);
    await expect(services.channelStockAllocations.set(command(itemId, 2), context)).resolves.toMatchObject({
      code: "channel-stock-allocation-history-invalid",
      reason: "inconsistent-history",
      eventIndex: 0,
    });
    expect(await count(itemId)).toBe(before);
  });

  it("guards the Inventory allocation read-model write against an interleaved older revision", async () => {
    const handlers = buildInventoryChannelStockAllocationProjectionHandlers(pool);
    const newer = payload("item-projection", {
      partitions: [{ channelConnectionId: "connection-synthetic", units: 7 }],
      setAt: "2026-09-11T18:02:00.000Z",
    });
    const older = payload("item-projection", {
      partitions: [{ channelConnectionId: "connection-synthetic", units: 2 }],
    });
    await handlers["inventory.channel-stock-allocation.set"]!(
      buildTransportEvent("inventory.channel-stock-allocation.set", newer, {
        streamId: channelStockAllocationStreamId("item-projection"),
        streamVersion: 2,
      }),
    );
    await handlers["inventory.channel-stock-allocation.set"]!(
      buildTransportEvent("inventory.channel-stock-allocation.set", older, {
        streamId: channelStockAllocationStreamId("item-projection"),
        streamVersion: 1,
      }),
    );
    await expect(
      services.channelStockAllocations.read({
        accountId: "account-synthetic",
        inventoryItemId: "item-projection",
      }),
    ).resolves.toMatchObject({ revision: 2, partitions: [{ units: 7 }] });
  });
});
