import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION, type GlobalPosition } from "@chase-sets/event-core/storage";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import { describe, expect, it, vi } from "vitest";
import { decideInventoryItem, initialInventoryItemState } from "../../inventory-items/domain/domain";
import { createInventoryHoldCollisionRuntime } from "../../hold-collisions/api/runtime";
import { externalChannelSaleStreamId } from "../domain/validation";
import type { RecordExternalChannelSaleCommand } from "./contracts";
import { createInventoryExternalChannelSaleRuntime, externalChannelSaleCommandFingerprint } from "./runtime";

type JournalRow = {
  inserted: boolean;
  command_fingerprint: string;
  claim_generation: string;
  status: "in_progress" | "completed";
  result_item_id: string | null;
  result_version: number | null;
  result_collision: unknown;
  created_at: string;
};

function checkpointStore(): ProjectionCheckpointStore {
  const values = new Map<string, GlobalPosition>();
  return {
    loadCheckpoint: async (name) => values.get(name) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (name, value) => void values.set(name, value),
  };
}

function baseCommand(
  line = "line-a",
  overrides: Partial<RecordExternalChannelSaleCommand> = {},
): RecordExternalChannelSaleCommand {
  return {
    accountId: "acc_seller",
    inventoryItemId: "inv_item",
    storageLocationId: "loc_main",
    saleKey: {
      version: "v1",
      providerKey: "synthetic-provider",
      sellerEnvironmentLineage: "seller-production",
      orderLineIdentity: line,
    },
    requestedQuantity: 1,
    unitPriceAmount: "12.34",
    currencyCode: "USD",
    soldAt: "2026-09-06T12:00:00-05:00",
    connectionAuditReference: "connection-a",
    ...overrides,
  };
}

function createHarness(options: Readonly<{ total?: number; activeHolds?: readonly Record<string, unknown>[] }> = {}) {
  const memory = createInMemoryEventStore();
  const journal = new Map<string, JournalRow>();
  let activeHolds = [...(options.activeHolds ?? [])];
  let failClaim = false;
  let failHolds = false;
  let failComplete = false;
  const db = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes("SELECT EXISTS (SELECT 1 FROM event_store_streams")) {
        return { rows: [{ present: memory.streams.has(String(values[0])) }], rowCount: 1 };
      }
      if (sql.includes("WITH inserted AS")) {
        if (failClaim) {
          failClaim = false;
          throw new Error("synthetic before-claim crash");
        }
        const key = String(values[0]);
        const existing = journal.get(key);
        if (existing) return { rows: [{ ...existing, inserted: false }], rowCount: 1 };
        const row: JournalRow = {
          inserted: true,
          command_fingerprint: String(values[3]),
          claim_generation: String(values[4]),
          status: "in_progress",
          result_item_id: null,
          result_version: null,
          result_collision: null,
          created_at: "2026-09-06T00:00:00.000Z",
        };
        journal.set(key, row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("UPDATE inventory_item_adjustment_idempotency")) {
        if (failComplete) {
          failComplete = false;
          throw new Error("synthetic after-append crash");
        }
        const key = String(values[0]);
        const row = journal.get(key);
        const owned =
          row?.status === "in_progress" &&
          row.command_fingerprint === String(values[1]) &&
          row.claim_generation === String(values[2]);
        if (row && owned) {
          journal.set(key, {
            ...row,
            inserted: false,
            status: "completed",
            result_item_id: String(values[3]),
            result_version: Number(values[4]),
            result_collision: JSON.parse(String(values[5])),
          });
        }
        return { rows: [], rowCount: owned ? 1 : 0 };
      }
      if (sql.includes("DELETE FROM inventory_item_adjustment_idempotency")) {
        const row = journal.get(String(values[0]));
        const owned =
          row?.status === "in_progress" &&
          row.command_fingerprint === String(values[1]) &&
          row.claim_generation === String(values[2]);
        if (owned) journal.delete(String(values[0]));
        return { rows: [], rowCount: owned ? 1 : 0 };
      }
      if (sql.includes("SELECT false AS inserted")) {
        const row = journal.get(String(values[0]));
        return { rows: row ? [{ ...row, inserted: false }] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes("WITH placed AS")) {
        if (failHolds) {
          failHolds = false;
          throw new Error("synthetic after-claim crash");
        }
        return { rows: activeHolds, rowCount: activeHolds.length };
      }
      throw new Error(`Unexpected synthetic query: ${sql}`);
    }),
  };
  const context = {
    tenantId: "tnt_inventory" as never,
    audit: { performedByUserId: "usr_inventory" as never, forAccountId: "acc_seller" as never },
  };
  const deps = { eventStore: memory.eventStore, checkpointStore: checkpointStore(), db: db as never };
  const holdCollisions = createInventoryHoldCollisionRuntime(deps);
  const sales = createInventoryExternalChannelSaleRuntime(deps, holdCollisions);

  async function seedItem() {
    const [created] = decideInventoryItem(initialInventoryItemState, {
      type: "CreateInventoryItem",
      itemId: "inv_item" as never,
      accountId: "acc_seller" as never,
      catalogItemId: "cat_item" as never,
      productId: "cat_item::raw" as never,
      selectedOptions: [],
      storageLocationId: "loc_main",
      totalQuantity: options.total ?? 10,
      acquisitionCostAmount: "4.00",
    });
    await memory.eventStore.appendToStream({
      streamId: "inventory.item-inv_item",
      expectedVersion: "no_stream",
      events: [{ eventType: created!.type, payload: created!.data }],
      context,
    });
  }

  return {
    ...memory,
    context,
    holdCollisions,
    journal,
    record: sales.bind(context),
    sales,
    seedItem,
    setActiveHolds: (rows: readonly Record<string, unknown>[]) => (activeHolds = [...rows]),
    crashBeforeClaim: () => (failClaim = true),
    crashAfterClaim: () => (failHolds = true),
    crashAfterAppend: () => (failComplete = true),
  };
}

const orderHold = (orderId: string, quantity: number) => ({
  hold_id: `hld_${orderId}`,
  quantity,
  purpose: "order",
  source_ref: { orderId, reservationRequestId: `rsv_${orderId}` },
  committed_at: "2026-09-06T10:00:00.000Z",
});

describe("external-channel-sale-idempotency", () => {
  it("returns the immutable first result across delivery paths and conflicts without another decrement", async () => {
    const harness = createHarness();
    await harness.seedItem();
    const first = await harness.record(baseCommand());
    const replay = await harness.record(baseCommand("line-a", { connectionAuditReference: "connection-b" }));
    const conflict = await harness.record(baseCommand("line-a", { requestedQuantity: 2 }));
    const otherAccountContext = {
      ...harness.context,
      audit: { ...harness.context.audit, forAccountId: "acc_other" as never },
    };
    const orderedConflict = await harness.sales.record(
      baseCommand("line-a", {
        accountId: "acc_other",
        inventoryItemId: "inv_other",
        storageLocationId: "loc_other",
        requestedQuantity: 3,
        unitPriceAmount: "99.00",
        currencyCode: "EUR",
        soldAt: "2026-09-07T12:00:00Z",
      }),
      otherAccountContext,
    );

    expect(replay).toEqual(first);
    expect(conflict).toMatchObject({
      code: "external-channel-sale-conflict",
      differingFields: ["requestedQuantity"],
    });
    expect(orderedConflict).toMatchObject({
      code: "external-channel-sale-conflict",
      differingFields: [
        "accountId",
        "inventoryItemId",
        "storageLocationId",
        "requestedQuantity",
        "unitPriceAmount",
        "currencyCode",
        "soldAt",
      ],
    });
    expect(harness.readAllEvents().filter((event) => event.eventType === "inventory.item.adjusted")).toHaveLength(1);
    expect(
      harness.readAllEvents().filter((event) => event.eventType === "inventory.external-channel-sale.recorded"),
    ).toHaveLength(1);
  });
});

describe("external-channel-sale-two-line-out-of-order", () => {
  it("records exactly two line facts across poll/notification permutations and reverse replay", async () => {
    const harness = createHarness();
    await harness.seedItem();
    for (const line of ["line-b", "line-a", "line-b", "line-a", "line-a", "line-b"]) {
      await expect(harness.record(baseCommand(line))).resolves.toMatchObject({ status: "committed" });
    }
    expect(
      harness.readAllEvents().filter((event) => event.eventType === "inventory.external-channel-sale.recorded"),
    ).toHaveLength(2);
    expect(harness.readAllEvents().filter((event) => event.eventType === "inventory.item.adjusted")).toHaveLength(2);
  });
});

describe("external-channel-sale-collision-path", () => {
  it("fails closed if an internal bypass tries to change the fixed mode or actor", async () => {
    const harness = createHarness();
    await harness.seedItem();
    const companion = {
      saleStreamId: externalChannelSaleStreamId(baseCommand("mode-bypass").saleKey),
      storageLocationId: "loc_main",
      inventoryAdjustmentEventId: "evt_synthetic_adjustment" as never,
      buildTerminalEvent: () => ({ eventType: "synthetic.never-written", payload: {} }),
    };
    const fixed = {
      accountId: "acc_seller",
      itemId: "inv_item",
      requestedQuantity: 1,
      reason: "External channel sale",
      reasonCode: "sold-external-channel" as const,
      externalChannelSale: companion,
    };
    await expect(
      harness.holdCollisions.reduceItem({ ...fixed, mode: "honor-offline", actorRole: null }, harness.context),
    ).rejects.toThrow("require protect-orders");
    await expect(
      harness.holdCollisions.reduceItem({ ...fixed, mode: "protect-orders", actorRole: "owner" }, harness.context),
    ).rejects.toThrow("require protect-orders");
    expect(harness.readAllEvents().filter((event) => event.eventType === "inventory.item.adjusted")).toHaveLength(0);
  });

  it.each([
    ["no collision", 5, [], 2, 2, 0],
    ["partial", 5, [orderHold("ord_b", 4)], 3, 1, 2],
    ["zero available", 5, [orderHold("ord_b", 5)], 3, 0, 3],
    ["requested above total", 5, [], 8, 5, 3],
  ] as const)("freezes %s protect-orders result", async (_name, total, holds, requested, applied, refused) => {
    const harness = createHarness({ total, activeHolds: holds });
    await harness.seedItem();
    const result = await harness.record(baseCommand("line-collision", { requestedQuantity: requested }));
    expect(result).toMatchObject({
      status: "committed",
      sale: {
        appliedQuantity: applied,
        refusedQuantity: refused,
        inventoryAdjustmentEventId: applied === 0 ? null : expect.any(String),
        saleShortfallKey: refused === 0 ? null : expect.any(String),
        protectedOrderIds: holds.length === 0 ? [] : ["ord_b"],
      },
    });
    expect(harness.readAllEvents().filter((event) => event.eventType === "inventory.item.adjusted")).toHaveLength(
      applied === 0 ? 0 : 1,
    );
    if (applied === 0) {
      expect(
        harness.readAllEvents().filter((event) => event.eventType === "inventory.item.stock-authority-claimed"),
      ).toHaveLength(1);
    }
    harness.setActiveHolds([]);
    expect(await harness.record(baseCommand("line-collision", { requestedQuantity: requested }))).toEqual(result);
  });
});

describe("external-channel-sale-crash-boundaries", () => {
  it("converges before claim, after claim, after append, after completion, retention, and concurrency", async () => {
    const before = createHarness();
    await before.seedItem();
    before.crashBeforeClaim();
    await expect(before.record(baseCommand("before"))).rejects.toThrow("before-claim");
    await expect(before.record(baseCommand("before"))).resolves.toMatchObject({ status: "committed" });

    const afterClaim = createHarness();
    await afterClaim.seedItem();
    afterClaim.crashAfterClaim();
    await expect(afterClaim.record(baseCommand("after-claim"))).rejects.toThrow("after-claim");
    expect(afterClaim.journal.size).toBe(0);
    await expect(afterClaim.record(baseCommand("after-claim"))).resolves.toMatchObject({ status: "committed" });

    const afterAppend = createHarness();
    await afterAppend.seedItem();
    afterAppend.crashAfterAppend();
    const recovered = await afterAppend.record(baseCommand("after-append"));
    expect(recovered).toMatchObject({ status: "committed" });
    const streamId = externalChannelSaleStreamId(baseCommand("after-append").saleKey);
    afterAppend.journal.delete(streamId);
    expect(await afterAppend.record(baseCommand("after-append"))).toEqual(recovered);

    const concurrent = createHarness();
    await concurrent.seedItem();
    const [left, right] = await Promise.all([
      concurrent.record(baseCommand("concurrent")),
      concurrent.record(baseCommand("concurrent")),
    ]);
    expect(right).toEqual(left);
    expect(
      concurrent.readAllEvents().filter((event) => event.eventType === "inventory.external-channel-sale.recorded"),
    ).toHaveLength(1);
    expect(concurrent.readAllEvents().filter((event) => event.eventType === "inventory.item.adjusted")).toHaveLength(1);
  });
});

describe("external-channel-sale-history", () => {
  it("rejects a stored offset soldAt even when its raw fingerprint agrees", async () => {
    const harness = createHarness();
    await harness.seedItem();
    const line = "poison-offset-sold-at";
    const rawSoldAt = "2026-09-06T12:00:00-05:00";
    const saleCommand = baseCommand(line, { soldAt: rawSoldAt });
    await harness.record(saleCommand);
    const streamId = externalChannelSaleStreamId(saleCommand.saleKey);
    const events = harness.streams.get(streamId)!;
    const payload = events[0]!.payload as Record<string, unknown>;
    (events[0] as { payload: unknown }).payload = {
      ...payload,
      soldAt: rawSoldAt,
      commandFingerprint: externalChannelSaleCommandFingerprint(saleCommand as never),
    };
    const eventCount = harness.readAllEvents().length;
    const adjustmentCount = harness
      .readAllEvents()
      .filter((event) => event.eventType === "inventory.item.adjusted").length;

    await expect(harness.record(saleCommand)).resolves.toMatchObject({
      code: "external-channel-sale-history-invalid",
      reason: "target-or-profile-mismatch",
    });
    expect(harness.readAllEvents()).toHaveLength(eventCount);
    expect(harness.readAllEvents().filter((event) => event.eventType === "inventory.item.adjusted")).toHaveLength(
      adjustmentCount,
    );
  });

  it("accepts canonical UTC stored soldAt and event references through the 128-scalar boundary", async () => {
    const harness = createHarness();
    await harness.seedItem();
    const canonicalCommand = baseCommand("canonical-utc", { soldAt: "2026-09-06T17:00:00.000Z" });
    const canonical = await harness.record(canonicalCommand);
    await expect(harness.record(canonicalCommand)).resolves.toEqual(canonical);

    const reference = (marker: string, length: number) => `evt_${marker.repeat(length - 4)}`;
    const cases = [
      {
        line: "max-128-event-references",
        saleEventId: reference("s", 128),
        inventoryAdjustmentEventId: reference("a", 128),
        accepted: true,
      },
      {
        line: "max-129-sale-event-reference",
        saleEventId: reference("s", 129),
        inventoryAdjustmentEventId: reference("a", 128),
        accepted: false,
      },
      {
        line: "max-129-adjustment-event-reference",
        saleEventId: reference("s", 128),
        inventoryAdjustmentEventId: reference("a", 129),
        accepted: false,
      },
    ] as const;

    for (const testCase of cases) {
      const saleCommand = baseCommand(testCase.line);
      await harness.record(saleCommand);
      const streamId = externalChannelSaleStreamId(saleCommand.saleKey);
      const events = harness.streams.get(streamId)!;
      const payload = events[0]!.payload as Record<string, unknown>;
      const result = payload.result as Record<string, unknown>;
      (events[0] as { eventId: string }).eventId = testCase.saleEventId;
      (events[0] as { payload: unknown }).payload = {
        ...payload,
        result: {
          ...result,
          saleEventId: testCase.saleEventId,
          inventoryAdjustmentEventId: testCase.inventoryAdjustmentEventId,
        },
      };
      const eventCount = harness.readAllEvents().length;
      const outcome = await harness.record(saleCommand);
      if (testCase.accepted) {
        expect(outcome).toMatchObject({
          status: "committed",
          sale: {
            saleEventId: testCase.saleEventId,
            inventoryAdjustmentEventId: testCase.inventoryAdjustmentEventId,
          },
        });
      } else {
        expect(outcome).toMatchObject({
          code: "external-channel-sale-history-invalid",
          reason: "malformed-result",
        });
      }
      expect(harness.readAllEvents()).toHaveLength(eventCount);
    }
  });

  it.each([
    ["empty-existing-stream", "empty"],
    ["unknown-event", "unknown"],
    ["unsupported-event-version", "unsupported"],
  ] as const)("fails closed for %s", async (reason, shape) => {
    const harness = createHarness();
    await harness.seedItem();
    const saleStreamId = externalChannelSaleStreamId(baseCommand(shape).saleKey);
    if (shape === "empty") {
      harness.streams.set(saleStreamId, []);
    } else {
      await harness.eventStore.appendToStream({
        streamId: saleStreamId,
        expectedVersion: "no_stream",
        events: [
          {
            eventType:
              shape === "unknown"
                ? "inventory.external-channel-sale.recorded-only"
                : "inventory.external-channel-sale.recorded",
            payload: { eventVersion: 2 },
          },
        ],
        context: harness.context,
      });
    }
    await expect(harness.record(baseCommand(shape))).resolves.toMatchObject({
      code: "external-channel-sale-history-invalid",
      reason,
    });
    expect(harness.readAllEvents().filter((event) => event.eventType === "inventory.item.adjusted")).toHaveLength(0);
  });

  it.each([
    ["duplicate-terminal", (payload: Record<string, unknown>) => payload, "duplicate"],
    ["trailing-event", (payload: Record<string, unknown>) => payload, "trailing"],
    [
      "key-stream-mismatch",
      (payload: Record<string, unknown>) => ({
        ...payload,
        saleKey: { ...(payload.saleKey as object), orderLineIdentity: "other" },
      }),
      "mutate",
    ],
    [
      "target-or-profile-mismatch",
      (payload: Record<string, unknown>) => ({ ...payload, collisionMode: "honor-offline" }),
      "mutate",
    ],
    [
      "malformed-result",
      (payload: Record<string, unknown>) => ({ ...payload, result: { ...(payload.result as object), unknown: true } }),
      "mutate",
    ],
    [
      "quantity-law-failure",
      (payload: Record<string, unknown>) => ({
        ...payload,
        result: { ...(payload.result as object), appliedQuantity: 9 },
      }),
      "mutate",
    ],
    [
      "stored-fingerprint-mismatch",
      (payload: Record<string, unknown>) => ({ ...payload, commandFingerprint: "0".repeat(64) }),
      "mutate",
    ],
  ] as const)("rejects %s terminal history", async (reason, mutate, mode) => {
    const harness = createHarness();
    await harness.seedItem();
    const command = baseCommand(`poison-${reason}`);
    await harness.record(command);
    const streamId = externalChannelSaleStreamId(command.saleKey);
    const events = harness.streams.get(streamId)!;
    if (mode === "duplicate" || mode === "trailing") {
      await harness.eventStore.appendToStream({
        streamId,
        expectedVersion: 1,
        events: [
          {
            eventType: mode === "duplicate" ? "inventory.external-channel-sale.recorded" : "synthetic.trailing",
            payload: events[0]!.payload,
          },
        ],
        context: harness.context,
      });
    } else {
      (events[0] as { payload: unknown }).payload = mutate(events[0]!.payload as Record<string, unknown>) as never;
    }
    await expect(harness.record(command)).resolves.toMatchObject({
      code: "external-channel-sale-history-invalid",
      reason,
    });
  });
});
