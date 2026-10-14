import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { validateInventoryItemStockHistory } from "../support/runtime-support/stock-history";

async function history() {
  const { eventStore } = createInMemoryEventStore();
  return eventStore.appendToStream({
    streamId: "inventory.item-inv_history",
    expectedVersion: "no_stream",
    context: {
      tenantId: "tnt_history",
      audit: { performedByUserId: "usr_history", forAccountId: "acc_history" },
    },
    events: [
      {
        eventType: "inventory.item.created",
        payload: { itemId: "inv_history", accountId: "acc_history", totalQuantity: 2 },
      },
      {
        eventType: "inventory.item.adjusted",
        payload: { itemId: "inv_history", quantityDelta: 3, reason: "Concurrent intake" },
      },
      {
        eventType: "inventory.item.stock-authority-claimed",
        payload: { itemId: "inv_history", quantity: 1, authorityRef: "hld_history", operation: "hold-placement" },
      },
      {
        eventType: "inventory.item.offline-sale-recorded",
        payload: { itemId: "inv_history", quantity: 1 },
      },
    ],
  });
}

function validate(events: readonly StoredEvent[], version = 1, totalQuantity = 2) {
  return validateInventoryItemStockHistory({
    events,
    itemId: "inv_history",
    accountId: "acc_history",
    tenantId: "tnt_history",
    version,
    totalQuantity,
  });
}

describe("Inventory stock history at the loaded version", () => {
  it.each([
    [1, 2],
    [2, 5],
    [3, 5],
    [4, 5],
  ])("accepts valid longer history using the v%i prefix total %i", async (version, total) => {
    const events = await history();
    expect(() => validate(events, version, total)).not.toThrow();
  });

  it("rejects short history and a loaded-prefix total mismatch even when the tail matches", async () => {
    const events = await history();
    expect(() => validate(events.slice(0, 1), 2, 5)).toThrow("reconciliation is required");
    expect(() => validate(events, 1, 5)).toThrow("reconciliation is required");
    expect(() => validate([], 1, 2)).toThrow("reconciliation is required");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 5])(
    "rejects invalid loaded version %s",
    async (version) => {
      const events = await history();
      expect(() => validate(events, version)).toThrow("reconciliation is required");
    },
  );

  const faults: ReadonlyArray<readonly [string, (event: StoredEvent, first: StoredEvent) => StoredEvent]> = [
    ["foreign stream", (event) => ({ ...event, streamId: "inventory.item-foreign" })],
    ["foreign tenant", (event) => ({ ...event, tenantId: "tnt_foreign" })],
    ["noncontiguous version", (event) => ({ ...event, streamVersion: event.streamVersion + 1 })],
    ["duplicate id", (event, first) => ({ ...event, eventId: first.eventId })],
    ["unknown event type", (event) => ({ ...event, eventType: "inventory.item.unknown" })],
    ["malformed payload", (event) => ({ ...event, payload: null as never })],
    ["foreign item", (event) => ({ ...event, payload: { ...event.payload, itemId: "inv_foreign" } })],
    ["noninteger delta", (event) => ({ ...event, payload: { ...event.payload, quantityDelta: 0.5 } })],
    ["missing reason", (event) => ({ ...event, payload: { ...event.payload, reason: "" } })],
    ["negative running total", (event) => ({ ...event, payload: { ...event.payload, quantityDelta: -3 } })],
    [
      "unsafe running total",
      (event) => ({ ...event, payload: { ...event.payload, quantityDelta: Number.MAX_SAFE_INTEGER } }),
    ],
  ];
  it.each(faults)("rejects %s in a concurrent tail beyond the loaded version", async (_name, fault) => {
    const events = await history();
    const poisoned = events.map((event, index) => (index === 1 ? fault(event, events[0]) : event));
    expect(() => validate(poisoned)).toThrow("reconciliation is required");
  });

  it.each([
    [0, "accountId", "acc_foreign"],
    [0, "totalQuantity", 0],
    [2, "quantity", 0],
    [2, "authorityRef", ""],
    [2, "operation", "unknown"],
    [3, "quantity", 0],
  ] as const)("rejects invalid payload at event %i: %s", async (index, key, value) => {
    const events = await history();
    const poisoned = events.map((event, position) =>
      position === index ? { ...event, payload: { ...event.payload, [key]: value } } : event,
    );
    expect(() => validate(poisoned)).toThrow("reconciliation is required");
  });

  it("rejects reordered history and a negative intermediate total even if a later adjustment repairs it", async () => {
    const events = await history();
    expect(() => validate([events[1], events[0], ...events.slice(2)])).toThrow("reconciliation is required");
    const repaired = events.map((event, index) =>
      index === 1 || index === 2
        ? {
            ...event,
            eventType: "inventory.item.adjusted",
            payload: { itemId: "inv_history", quantityDelta: index === 1 ? -3 : 6, reason: "Correction" },
          }
        : event,
    );
    expect(() => validate(repaired)).toThrow("reconciliation is required");
  });
});
