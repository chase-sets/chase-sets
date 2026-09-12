import { describe, expect, it } from "vitest";
import {
  CHANNEL_STOCK_ALLOCATION_BUFFER_POLICY_FALLBACK,
  channelStockAllocationBufferPolicy,
  decodeChannelStockAllocationBufferPolicy,
  deriveChannelPublishQuantity,
  resolveChannelStockAllocationBufferPolicy,
} from "../domain/allocation";

const shared = { mode: "shared-pool" as const, partitions: [] };
const partitioned = {
  mode: "partitioned" as const,
  partitions: [
    { channelConnectionId: "connection-a", units: 3 },
    { channelConnectionId: "connection-without-link", units: 99 },
  ],
};

function derive(overrides: Partial<Parameters<typeof deriveChannelPublishQuantity>[0]> = {}) {
  return deriveChannelPublishQuantity({
    available: 10,
    listingQuantityCap: 100,
    channelConnectionId: "connection-a",
    allocation: shared,
    buffer: CHANNEL_STOCK_ALLOCATION_BUFFER_POLICY_FALLBACK,
    ...overrides,
  });
}

describe("channel-publish-quantity-matrix", () => {
  it.each([
    ["buffer off", 9, { bufferThresholdUnits: 0, bufferHoldbackUnits: 0 }, 9],
    ["threshold minus one", 4, { bufferThresholdUnits: 5, bufferHoldbackUnits: 2 }, 2],
    ["threshold", 5, { bufferThresholdUnits: 5, bufferHoldbackUnits: 2 }, 5],
    ["threshold plus one", 6, { bufferThresholdUnits: 5, bufferHoldbackUnits: 2 }, 6],
    ["holdback above available clamps", 1, { bufferThresholdUnits: 5, bufferHoldbackUnits: 4 }, 0],
    ["available zero", 0, { bufferThresholdUnits: 5, bufferHoldbackUnits: 2 }, 0],
  ])("shared-pool applies one pool-wide buffer: %s", (_label, available, buffer, expected) => {
    expect(derive({ available, buffer })).toBe(expected);
    expect(derive({ available, buffer, channelConnectionId: "connection-b" })).toBe(expected);
  });

  it.each([
    ["units below available", 10, "connection-a", 3],
    ["units equal available", 3, "connection-a", 3],
    ["units above available", 2, "connection-a", 2],
    ["no partition entry", 10, "connection-b", 0],
    ["available zero", 0, "connection-a", 0],
  ])("partitioned caps the named connection: %s", (_label, available, channelConnectionId, expected) => {
    expect(derive({ available, channelConnectionId, allocation: partitioned })).toBe(expected);
  });

  it("retains the listing quantity cap without exposing a Hold, Order, or Inventory writer", () => {
    expect(derive({ allocation: partitioned, channelConnectionId: "connection-a", listingQuantityCap: 2 })).toBe(2);
    // The derivation is referentially transparent: it has no Hold, Order, or Inventory writer capability.
    expect(partitioned).toEqual({
      mode: "partitioned",
      partitions: [
        { channelConnectionId: "connection-a", units: 3 },
        { channelConnectionId: "connection-without-link", units: 99 },
      ],
    });
  });

  it("treats partitions as independent publish caps, not a consumable or zero-oversell ledger", () => {
    const allocation = {
      mode: "partitioned" as const,
      partitions: [
        { channelConnectionId: "connection-a", units: 8 },
        { channelConnectionId: "connection-b", units: 8 },
      ],
    };
    expect(derive({ available: 10, allocation, channelConnectionId: "connection-a" })).toBe(8);
    expect(derive({ available: 10, allocation, channelConnectionId: "connection-b" })).toBe(8);
  });

  it("channel-stock-allocation-policy-value validates the full document and safely falls back on malformed value", async () => {
    expect(channelStockAllocationBufferPolicy).toMatchObject({
      policyKey: "inventory.channel-stock-allocation-buffer",
      contextName: "inventory",
      defaultValue: { bufferThresholdUnits: 0, bufferHoldbackUnits: 0 },
    });
    expect(decodeChannelStockAllocationBufferPolicy({ bufferThresholdUnits: 5, bufferHoldbackUnits: 2 })).toEqual({
      bufferThresholdUnits: 5,
      bufferHoldbackUnits: 2,
    });
    for (const malformed of [
      { bufferThresholdUnits: 5 },
      { bufferThresholdUnits: 5, bufferHoldbackUnits: 2, unknown: true },
      { bufferThresholdUnits: 5, bufferHoldbackUnits: -1 },
      { bufferThresholdUnits: 1_001, bufferHoldbackUnits: 2 },
      { bufferThresholdUnits: 5, bufferHoldbackUnits: 1.5 },
    ]) {
      expect(() => decodeChannelStockAllocationBufferPolicy(malformed as never)).toThrow();
    }
    await expect(
      resolveChannelStockAllocationBufferPolicy(async () =>
        decodeChannelStockAllocationBufferPolicy({
          bufferThresholdUnits: 5,
          bufferHoldbackUnits: "synthetic-malformed-value",
        } as never),
      ),
    ).resolves.toEqual(CHANNEL_STOCK_ALLOCATION_BUFFER_POLICY_FALLBACK);
    await expect(
      resolveChannelStockAllocationBufferPolicy(async () => {
        throw new Error("synthetic database unavailable");
      }),
    ).rejects.toThrow("synthetic database unavailable");
    await expect(
      resolveChannelStockAllocationBufferPolicy(async () => {
        throw new Error("Invalid inventory Channel Stock Allocation buffer policy: synthetic infrastructure spoof.");
      }),
    ).rejects.toThrow("synthetic infrastructure spoof");
  });
});
