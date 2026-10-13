import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { JsonObject } from "@chase-sets/primitives/json";
import { initialInventoryItemState } from "../features/inventory-items/domain/domain";
import { loadAuthoritativeInventoryStockSnapshot } from "../support/runtime-support/stock-snapshot";
import { createInventoryHoldCollisionRuntime } from "../features/hold-collisions/api/runtime";
import { loadInventoryStockHolds } from "../support/runtime-support/stock-history";
import { inventorySchemaMigrations } from "../support/runtime-support/schema";

const context: EventStoreContext = {
  tenantId: "tnt_c1_synthetic",
  audit: { performedByUserId: "usr_c1_synthetic", forAccountId: "acc_c1_synthetic" },
};
const accountId = context.audit.forAccountId as AccountId;
const placed = {
  holdId: "hld_c1_synthetic",
  accountId,
  itemId: "inv_c1_synthetic",
  quantity: 2,
  reason: "Synthetic stock-history control",
  notes: null,
  purpose: "manual",
  sourceRef: null,
  expiresAt: null,
};
type Fact = { eventType: string; payload: JsonObject };

async function stockHarness(facts: Fact[]) {
  const { eventStore } = createInMemoryEventStore();
  await eventStore.appendToStream({
    streamId: "inventory.item-inv_c1_synthetic",
    expectedVersion: "no_stream",
    context,
    events: [
      {
        eventType: "inventory.item.created",
        payload: {
          itemId: "inv_c1_synthetic",
          accountId,
          catalogItemId: "cat_c1_synthetic",
          productId: "cat_c1_synthetic::raw",
          selectedOptions: [],
          gradedCard: null,
          storageLocationId: "loc_c1_synthetic",
          totalQuantity: 5,
          acquisitionCostAmount: null,
        },
      },
    ],
  });
  await eventStore.appendToStream({
    streamId: "inventory.hold-hld_c1_synthetic",
    expectedVersion: "no_stream",
    context,
    events: facts,
  });
  // Both query shapes read the same frozen facts. This models the old SQL's
  // quantity filter and terminal join, not a pre-cleaned authority fixture.
  const db = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("placed_holds")) {
        return {
          rows: facts
            .filter((fact) => fact.eventType === "inventory.hold.placed")
            .filter((fact) => typeof fact.payload.quantity === "number")
            .map((fact) => ({
              hold_id: fact.payload.holdId,
              account_id: fact.payload.accountId,
              item_id: fact.payload.itemId,
              quantity: fact.payload.quantity,
              active: !facts.some((entry) =>
                ["inventory.hold.released", "inventory.hold.expired", "inventory.hold.consumed"].includes(
                  entry.eventType,
                ),
              ),
            })),
        };
      }
      if (sql.includes("WITH placed AS")) {
        return {
          rows: facts
            .filter((fact) => fact.eventType === "inventory.hold.placed")
            .filter(
              () =>
                !facts.some((entry) =>
                  ["inventory.hold.released", "inventory.hold.expired", "inventory.hold.consumed"].includes(
                    entry.eventType,
                  ),
                ),
            )
            .map((fact) => ({
              hold_id: fact.payload.holdId,
              quantity: fact.payload.quantity,
              purpose: fact.payload.purpose,
              source_ref: fact.payload.sourceRef,
              committed_at: "2026-10-12T12:00:00Z",
            })),
        };
      }
      if (
        process.env.CHASE_SETS_C1_MUTANT === "sql-poison-drop" &&
        sql.includes("WITH candidates AS") &&
        !facts.some((fact) => fact.eventType === "inventory.hold.placed" && typeof fact.payload.quantity === "number")
      ) {
        return { rows: [] };
      }
      return {
        rows: [{ stream_id: "inventory.hold-hld_c1_synthetic", total: "1", current_version: String(facts.length) }],
      };
    }),
  };
  const state = { ...initialInventoryItemState, id: "inv_c1_synthetic" as never, accountId, totalQuantity: 5 };
  return {
    db,
    eventStore,
    itemRepository: { load: async () => ({ state, version: 1 }) },
    itemId: "inv_c1_synthetic",
    accountId,
    context,
  };
}

describe("issue-7169-ac3-stock-invariants: complete stock authority", () => {
  it("reads a decisive poisoned fact beyond the event-store page boundary", async () => {
    const start = Date.parse("2026-10-12T12:00:00Z");
    const facts: Fact[] = [
      {
        eventType: "inventory.hold.placed",
        payload: {
          ...placed,
          purpose: "checkout",
          sourceRef: { checkoutSessionId: "chk_synthetic", lineKey: "line_synthetic" },
          expiresAt: new Date(start).toISOString(),
        },
      },
    ];
    for (let index = 1; index <= 500; index++)
      facts.push({
        eventType: "inventory.hold.extended",
        payload: {
          holdId: placed.holdId,
          extendedAt: "2026-10-12T11:00:00Z",
          expiresAt: new Date(start + index * 60_000).toISOString(),
          extensionCount: index,
        },
      });
    const valid = await stockHarness(facts);
    expect(await loadAuthoritativeInventoryStockSnapshot(valid)).toMatchObject({ heldQuantity: 2 });
    const poisoned = await stockHarness([
      ...facts,
      { eventType: "inventory.hold.unknown", payload: { holdId: placed.holdId } },
    ]);
    await expect(loadAuthoritativeInventoryStockSnapshot(poisoned)).rejects.toThrow();
  });

  it("rejects a short read that disagrees with the owning stream version", async () => {
    const deps = await stockHarness([
      { eventType: "inventory.hold.placed", payload: placed },
      {
        eventType: "inventory.hold.released",
        payload: { holdId: placed.holdId, releasedAt: "2026-10-12T12:00:00Z", releaseReason: "manual" },
      },
    ]);
    const reader = {
      ...deps.eventStore,
      readStream: async (input: Parameters<typeof deps.eventStore.readStream>[0]) => {
        const events = await deps.eventStore.readStream(input);
        return input.streamId.startsWith("inventory.hold-") ? events.slice(0, 1) : events;
      },
    };
    await expect(loadAuthoritativeInventoryStockSnapshot({ ...deps, eventStore: reader })).rejects.toThrow();
  });

  it("pages every discovered stream and reconciles the independent total", async () => {
    const { eventStore } = createInMemoryEventStore();
    const streamIds: string[] = [];
    for (let index = 0; index < 501; index++) {
      const holdId = `hld_c1_synthetic_${String(index).padStart(3, "0")}`;
      const streamId = `inventory.hold-${holdId}`;
      streamIds.push(streamId);
      await eventStore.appendToStream({
        streamId,
        expectedVersion: "no_stream",
        context,
        events: [{ eventType: "inventory.hold.placed", payload: { ...placed, holdId, quantity: 1 } }],
      });
    }
    const query = vi.fn(async (_sql: string, values: readonly unknown[] = []) => ({
      rows: streamIds
        .filter((id) => id > String(values[3]))
        .slice(0, Number(values[4]))
        .map((stream_id) => ({
          stream_id,
          total: "501",
          current_version: "1",
        })),
    }));
    const input = { eventStore, db: { query }, accountId, itemId: placed.itemId, context };
    expect(await loadInventoryStockHolds(input)).toHaveLength(501);
    expect(query).toHaveBeenCalledTimes(3);
    query.mockImplementation(async () => ({ rows: [{ stream_id: streamIds[0], total: "501", current_version: "1" }] }));
    await expect(loadInventoryStockHolds(input)).rejects.toThrow();
  });

  it("registers concurrent discovery indexes as new owner-ledger migrations", () => {
    const migration = inventorySchemaMigrations.find(
      (entry) => entry.migrationId === "20261013_inventory_hold_stock_history_indexes",
    );
    expect(migration?.statements).toHaveLength(2);
    for (const statement of migration!.statements) {
      expect(statement).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS");
      expect(statement).not.toContain("jsonb_typeof");
    }
  });
  it("rejects poisoned history through the real negative-adjustment collision service", async () => {
    const deps = await stockHarness([{ eventType: "inventory.hold.placed", payload: { ...placed, quantity: "2" } }]);
    const collisions = createInventoryHoldCollisionRuntime({ ...deps, checkpointStore: {} as never });
    await expect(
      collisions.reduceItem(
        {
          accountId,
          itemId: "inv_c1_synthetic",
          requestedQuantity: 1,
          reason: "Synthetic reduction",
          mode: "protect-orders",
        },
        context,
      ),
    ).rejects.toThrow();
  });
  it.each([
    ["malformed quantity", [{ eventType: "inventory.hold.placed", payload: { ...placed, quantity: "2" } }]],
    ["zero quantity", [{ eventType: "inventory.hold.placed", payload: { ...placed, quantity: 0 } }]],
    ["negative quantity", [{ eventType: "inventory.hold.placed", payload: { ...placed, quantity: -2 } }]],
    ["fractional quantity", [{ eventType: "inventory.hold.placed", payload: { ...placed, quantity: 0.5 } }]],
    [
      "unsafe quantity",
      [{ eventType: "inventory.hold.placed", payload: { ...placed, quantity: Number.MAX_SAFE_INTEGER + 1 } }],
    ],
    ["unknown placement field", [{ eventType: "inventory.hold.placed", payload: { ...placed, extra: true } }]],
    [
      "unknown nested source",
      [
        {
          eventType: "inventory.hold.placed",
          payload: {
            ...placed,
            purpose: "order",
            sourceRef: { orderId: "ord_synthetic", reservationRequestId: "rsv_synthetic", extra: true },
          },
        },
      ],
    ],
    ["unsupported purpose", [{ eventType: "inventory.hold.placed", payload: { ...placed, purpose: "pos" } }]],
    [
      "date-only checkout expiry",
      [
        {
          eventType: "inventory.hold.placed",
          payload: {
            ...placed,
            purpose: "checkout",
            sourceRef: { checkoutSessionId: "chk_synthetic", lineKey: "line_synthetic" },
            expiresAt: "2026-10-12",
          },
        },
      ],
    ],
    [
      "duplicate placement",
      [
        { eventType: "inventory.hold.placed", payload: placed },
        { eventType: "inventory.hold.placed", payload: placed },
      ],
    ],
    [
      "duplicate terminal",
      [
        { eventType: "inventory.hold.placed", payload: placed },
        {
          eventType: "inventory.hold.released",
          payload: { holdId: placed.holdId, releasedAt: "2026-10-12T12:00:00Z", releaseReason: "manual" },
        },
        {
          eventType: "inventory.hold.released",
          payload: { holdId: placed.holdId, releasedAt: "2026-10-12T12:01:00Z", releaseReason: "manual" },
        },
      ],
    ],
    [
      "post-terminal fact",
      [
        { eventType: "inventory.hold.placed", payload: placed },
        {
          eventType: "inventory.hold.released",
          payload: { holdId: placed.holdId, releasedAt: "2026-10-12T12:00:00Z", releaseReason: "manual" },
        },
        {
          eventType: "inventory.hold.extended",
          payload: { holdId: placed.holdId, expiresAt: "2026-10-13T12:00:00Z", extensionCount: 1 },
        },
      ],
    ],
    [
      "mixed identity",
      [
        { eventType: "inventory.hold.placed", payload: placed },
        {
          eventType: "inventory.hold.released",
          payload: { holdId: "hld_foreign_synthetic", releasedAt: "2026-10-12T12:00:00Z", releaseReason: "manual" },
        },
      ],
    ],
    [
      "unknown fact",
      [
        { eventType: "inventory.hold.placed", payload: placed },
        { eventType: "inventory.hold.unknown", payload: { holdId: placed.holdId } },
      ],
    ],
    ["negative availability", [{ eventType: "inventory.hold.placed", payload: { ...placed, quantity: 6 } }]],
  ] satisfies [string, Fact[]][])("rejects %s rather than cleaning history", async (_name, facts) => {
    await expect(loadAuthoritativeInventoryStockSnapshot(await stockHarness(facts))).rejects.toThrow();
  });

  it("counts a valid active hold and excludes exactly one valid terminal", async () => {
    const active = await stockHarness([{ eventType: "inventory.hold.placed", payload: placed }]);
    expect(await loadAuthoritativeInventoryStockSnapshot(active)).toMatchObject({
      heldQuantity: 2,
      availableQuantity: 3,
    });
    const terminal = await stockHarness([
      { eventType: "inventory.hold.placed", payload: placed },
      {
        eventType: "inventory.hold.released",
        payload: { holdId: placed.holdId, releasedAt: "2026-10-12T12:00:00Z", releaseReason: "manual" },
      },
    ]);
    expect(await loadAuthoritativeInventoryStockSnapshot(terminal)).toMatchObject({
      heldQuantity: 0,
      availableQuantity: 5,
    });
  });
});
