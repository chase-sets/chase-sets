import { describe, expect, it } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createInventoryChannelStockAllocationRuntime } from "../api/runtime";
import {
  absentChannelStockAllocation,
  channelAllocationModes,
  normalizeSetChannelStockAllocationCommand,
} from "../domain/allocation";
import { channelStockAllocationEventCodec } from "../domain/codec";

const context: EventStoreContext = {
  tenantId: "tnt_synthetic_allocation" as never,
  audit: {
    performedByUserId: "usr_synthetic_allocation" as never,
    forAccountId: "account-synthetic" as never,
  },
};

function command(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "account-synthetic",
    inventoryItemId: "item-synthetic",
    mode: "partitioned",
    partitions: [{ channelConnectionId: "connection-a", units: 2 }],
    expectedRevision: 0,
    ...overrides,
  };
}

describe("channel-stock-allocation-contract", () => {
  it("keeps the valid-mode registry distinct from the absent aggregate default", () => {
    expect(channelAllocationModes).toEqual(["shared-pool", "partitioned"]);
    expect(absentChannelStockAllocation("account-synthetic", "item-synthetic")).toEqual({
      accountId: "account-synthetic",
      inventoryItemId: "item-synthetic",
      mode: "shared-pool",
      partitions: [],
      revision: 0,
      setAt: null,
    });
  });

  it("accepts closed, scalar-sorted absolute commands at every inclusive bound", () => {
    const maximumReference = `connection-${"😀".repeat(117)}`;
    expect(Array.from(maximumReference)).toHaveLength(128);
    expect(
      normalizeSetChannelStockAllocationCommand(
        command({
          partitions: [
            { channelConnectionId: "connection-a", units: 0 },
            { channelConnectionId: maximumReference, units: 2_147_483_647 },
          ],
        }),
      ),
    ).toMatchObject({ mode: "partitioned", expectedRevision: 0 });
    expect(normalizeSetChannelStockAllocationCommand(command({ mode: "shared-pool", partitions: [] }))).toMatchObject({
      mode: "shared-pool",
      partitions: [],
    });
  });

  it.each([
    ["unknown root key", command({ unknown: true })],
    ["missing root key", { accountId: "account-synthetic" }],
    ["unknown nested key", command({ partitions: [{ channelConnectionId: "connection-a", units: 1, x: 1 }] })],
    ["unknown mode", command({ mode: "pooled" })],
    ["shared partitions", command({ mode: "shared-pool", partitions: [{ channelConnectionId: "a", units: 1 }] })],
    [
      "unsorted partitions",
      command({
        partitions: [
          { channelConnectionId: "connection-b", units: 1 },
          { channelConnectionId: "connection-a", units: 1 },
        ],
      }),
    ],
    [
      "duplicate partitions",
      command({
        partitions: [
          { channelConnectionId: "connection-a", units: 1 },
          { channelConnectionId: "connection-a", units: 2 },
        ],
      }),
    ],
    ["negative units", command({ partitions: [{ channelConnectionId: "connection-a", units: -1 }] })],
    ["fractional units", command({ partitions: [{ channelConnectionId: "connection-a", units: 1.5 }] })],
    ["units overflow", command({ partitions: [{ channelConnectionId: "connection-a", units: 2_147_483_648 }] })],
    ["empty connection", command({ partitions: [{ channelConnectionId: "", units: 1 }] })],
    ["trimmed connection", command({ partitions: [{ channelConnectionId: " connection-a", units: 1 }] })],
    ["non-NFC connection", command({ partitions: [{ channelConnectionId: "e\u0301", units: 1 }] })],
    ["control connection", command({ partitions: [{ channelConnectionId: "connection\u0000a", units: 1 }] })],
    ["surrogate connection", command({ partitions: [{ channelConnectionId: "connection\ud800", units: 1 }] })],
    ["noncharacter connection", command({ partitions: [{ channelConnectionId: "connection\ufdd0", units: 1 }] })],
    ["negative revision", command({ expectedRevision: -1 })],
  ])("rejects %s before reading or appending", async (_label, candidate) => {
    let reads = 0;
    let appends = 0;
    const runtime = createInventoryChannelStockAllocationRuntime({
      eventStore: {
        readStream: async () => {
          reads += 1;
          return [];
        },
        readAll: async () => [],
        appendToStream: async () => {
          appends += 1;
          return [];
        },
      },
      checkpointStore: {
        loadCheckpoint: async () => "0" as never,
        saveCheckpoint: async () => undefined,
      },
      db: { query: async () => ({ rows: [] }) },
    });
    await expect(runtime.set(candidate as never, context)).rejects.toThrow();
    expect({ reads, appends }).toEqual({ reads: 0, appends: 0 });
  });

  it("rejects an account-context mismatch before reading or appending", async () => {
    let reads = 0;
    let appends = 0;
    const runtime = createInventoryChannelStockAllocationRuntime({
      eventStore: {
        readStream: async () => {
          reads += 1;
          return [];
        },
        readAll: async () => [],
        appendToStream: async () => {
          appends += 1;
          return [];
        },
      },
      checkpointStore: {
        loadCheckpoint: async () => "0" as never,
        saveCheckpoint: async () => undefined,
      },
      db: { query: async () => ({ rows: [] }) },
    });
    await expect(
      runtime.set(command() as never, {
        ...context,
        audit: { ...context.audit, forAccountId: "account-other" as never },
      }),
    ).rejects.toThrow(/must match/);
    expect({ reads, appends }).toEqual({ reads: 0, appends: 0 });
  });

  it("round-trips only the recursively closed v1 allocation event", () => {
    const event = {
      type: "inventory.channel-stock-allocation.set" as const,
      data: {
        eventVersion: 1 as const,
        accountId: "account-synthetic",
        inventoryItemId: "item-synthetic",
        mode: "partitioned" as const,
        partitions: [{ channelConnectionId: "connection-a", units: 2 }],
        setAt: "2026-09-11T18:00:00.000Z",
      },
    };
    const encoded = channelStockAllocationEventCodec.encode(event);
    expect(channelStockAllocationEventCodec.decode(encoded)).toEqual(event);
    expect(() =>
      channelStockAllocationEventCodec.decode({
        ...encoded,
        payload: { ...event.data, partitions: [{ ...event.data.partitions[0], unknown: true }] } as never,
      }),
    ).toThrow(/recursively closed/);
  });
});
