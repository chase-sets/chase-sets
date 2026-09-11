import { inventoryChannelAllocationModes } from "@chase-sets/event-core/public-event-payloads/inventory";
import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

export const channelStockAllocationModes = inventoryChannelAllocationModes;
export type ChannelStockAllocationMode = (typeof channelStockAllocationModes)[number];

export type ChannelStockAllocationFacts = Readonly<{
  mode: ChannelStockAllocationMode;
  partitions: readonly Readonly<{ channelConnectionId: string; units: number }>[];
}>;

export type ChannelStockAllocationBufferPolicyValue = Readonly<{
  bufferThresholdUnits: number;
  bufferHoldbackUnits: number;
}>;

export const CHANNEL_STOCK_ALLOCATION_BUFFER_POLICY_FALLBACK: ChannelStockAllocationBufferPolicyValue = Object.freeze({
  bufferThresholdUnits: 0,
  bufferHoldbackUnits: 0,
});

export const channelStockAllocationBufferPolicy: PolicyDefinition<ChannelStockAllocationBufferPolicyValue> =
  definePolicy({
    policyKey: "inventory.channel-stock-allocation-buffer",
    contextName: "inventory",
    schemaSummary: "{ bufferThresholdUnits: integer 0-1000, bufferHoldbackUnits: integer 0-1000 }",
    defaultValue: CHANNEL_STOCK_ALLOCATION_BUFFER_POLICY_FALLBACK,
    decodeValue: decodeChannelStockAllocationBufferPolicy,
  });

export function decodeChannelStockAllocationBufferPolicy(raw: JsonValue): ChannelStockAllocationBufferPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) invalid("value must be an object.");
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(record, "bufferThresholdUnits") ||
    !Object.hasOwn(record, "bufferHoldbackUnits")
  ) {
    invalid("value must contain exactly bufferThresholdUnits and bufferHoldbackUnits.");
  }
  return Object.freeze({
    bufferThresholdUnits: boundedInteger(record.bufferThresholdUnits, "bufferThresholdUnits"),
    bufferHoldbackUnits: boundedInteger(record.bufferHoldbackUnits, "bufferHoldbackUnits"),
  });
}

export async function resolveChannelStockAllocationBufferPolicy(
  resolve: () => Promise<ChannelStockAllocationBufferPolicyValue>,
): Promise<ChannelStockAllocationBufferPolicyValue> {
  try {
    return await resolve();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Invalid inventory Channel Stock Allocation buffer policy:")
    ) {
      return CHANNEL_STOCK_ALLOCATION_BUFFER_POLICY_FALLBACK;
    }
    throw error;
  }
}

export function deriveChannelPublishQuantity(
  input: Readonly<{
    available: number;
    listingQuantityCap: number;
    channelConnectionId: string;
    allocation: ChannelStockAllocationFacts;
    buffer: ChannelStockAllocationBufferPolicyValue;
  }>,
): number {
  const available = Math.max(0, input.available);
  const allocated =
    input.allocation.mode === "shared-pool"
      ? Math.max(0, available - (available < input.buffer.bufferThresholdUnits ? input.buffer.bufferHoldbackUnits : 0))
      : Math.min(
          input.allocation.partitions.find((partition) => partition.channelConnectionId === input.channelConnectionId)
            ?.units ?? 0,
          available,
        );
  return Math.max(0, Math.min(input.listingQuantityCap, allocated));
}

function boundedInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 1000) {
    invalid(`${label} must be an integer from 0 to 1000.`);
  }
  return Number(value);
}

function invalid(message: string): never {
  throw new Error(`Invalid inventory Channel Stock Allocation buffer policy: ${message}`);
}
