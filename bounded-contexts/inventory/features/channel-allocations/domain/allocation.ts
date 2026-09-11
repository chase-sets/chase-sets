import { inventoryChannelAllocationModes } from "@chase-sets/event-core/public-event-payloads/inventory";
import type {
  InventoryChannelAllocationMode,
  InventoryChannelStockAllocationPartitionPayload,
  InventoryChannelStockAllocationSetPayload,
} from "@chase-sets/event-core/public-event-payloads/inventory";
import { InventoryDomainError } from "../../../support/runtime-support/common";

export const channelAllocationModes = inventoryChannelAllocationModes;
export type ChannelAllocationMode = InventoryChannelAllocationMode;
export type ChannelStockAllocationPartition = InventoryChannelStockAllocationPartitionPayload;

export const CHANNEL_STOCK_ALLOCATION_EVENT_TYPE = "inventory.channel-stock-allocation.set" as const;
export const CHANNEL_STOCK_ALLOCATION_EVENT_VERSION = 1 as const;
export const CHANNEL_STOCK_ALLOCATION_MAX_UNITS = 2_147_483_647;

export type SetChannelStockAllocationCommand = Readonly<{
  accountId: string;
  inventoryItemId: string;
  mode: ChannelAllocationMode;
  partitions: readonly ChannelStockAllocationPartition[];
  expectedRevision: number;
}>;

export type ChannelStockAllocation = Readonly<{
  accountId: string;
  inventoryItemId: string;
  mode: ChannelAllocationMode;
  partitions: readonly ChannelStockAllocationPartition[];
  revision: number;
  setAt: string | null;
}>;

export function channelStockAllocationStreamId(inventoryItemId: string): string {
  return `inventory.channel-stock-allocation-${inventoryItemId}`;
}

export function absentChannelStockAllocation(accountId: string, inventoryItemId: string): ChannelStockAllocation {
  return {
    accountId,
    inventoryItemId,
    mode: "shared-pool",
    partitions: [],
    revision: 0,
    setAt: null,
  };
}

export function normalizeSetChannelStockAllocationCommand(value: unknown): SetChannelStockAllocationCommand {
  const record = closedRecord(
    value,
    ["accountId", "inventoryItemId", "mode", "partitions", "expectedRevision"],
    "SetChannelStockAllocation",
  );
  const accountId = opaqueReference(record.accountId, "accountId", 128);
  const inventoryItemId = opaqueReference(record.inventoryItemId, "inventoryItemId", 128);
  const mode = allocationMode(record.mode);
  const partitions = allocationPartitions(record.partitions, mode);
  const expectedRevision = integer(record.expectedRevision, 0, Number.MAX_SAFE_INTEGER, "expectedRevision");
  return Object.freeze({ accountId, inventoryItemId, mode, partitions, expectedRevision });
}

export function assertChannelStockAllocationEventPayload(
  value: unknown,
): asserts value is InventoryChannelStockAllocationSetPayload {
  const record = closedRecord(
    value,
    ["eventVersion", "accountId", "inventoryItemId", "mode", "partitions", "setAt"],
    "Channel Stock Allocation event",
  );
  if (record.eventVersion !== CHANNEL_STOCK_ALLOCATION_EVENT_VERSION) {
    invalid("Channel Stock Allocation eventVersion is unsupported.");
  }
  opaqueReference(record.accountId, "accountId", 128);
  opaqueReference(record.inventoryItemId, "inventoryItemId", 128);
  const mode = allocationMode(record.mode);
  allocationPartitions(record.partitions, mode);
  canonicalUtcInstant(record.setAt, "setAt");
}

export function evolveChannelStockAllocation(
  _state: ChannelStockAllocation,
  event: InventoryChannelStockAllocationSetPayload,
  revision: number,
): ChannelStockAllocation {
  return {
    accountId: event.accountId,
    inventoryItemId: event.inventoryItemId,
    mode: event.mode,
    partitions: event.partitions,
    revision,
    setAt: event.setAt,
  };
}

function allocationMode(value: unknown): ChannelAllocationMode {
  if (typeof value !== "string" || !channelAllocationModes.includes(value as ChannelAllocationMode)) {
    invalid("Channel Allocation Mode must be shared-pool or partitioned.");
  }
  return value as ChannelAllocationMode;
}

function allocationPartitions(value: unknown, mode: ChannelAllocationMode): readonly ChannelStockAllocationPartition[] {
  if (!Array.isArray(value)) invalid("Channel Stock Allocation partitions must be an array.");
  const partitions = value.map((candidate, index) => {
    const partition = closedRecord(candidate, ["channelConnectionId", "units"], `partitions[${index}]`);
    return Object.freeze({
      channelConnectionId: channelConnectionReference(partition.channelConnectionId),
      units: integer(partition.units, 0, CHANNEL_STOCK_ALLOCATION_MAX_UNITS, `partitions[${index}].units`),
    });
  });
  if (mode === "shared-pool" && partitions.length !== 0) {
    invalid("Shared-pool Channel Stock Allocation cannot declare partitions.");
  }
  for (let index = 1; index < partitions.length; index += 1) {
    if (
      compareUnicodeScalars(partitions[index - 1]!.channelConnectionId, partitions[index]!.channelConnectionId) >= 0
    ) {
      invalid("Channel Stock Allocation partitions must be unique and ascending by channelConnectionId.");
    }
  }
  return Object.freeze(partitions);
}

function channelConnectionReference(value: unknown): string {
  const reference = opaqueReference(value, "channelConnectionId", 128);
  if (reference.normalize("NFC") !== reference) invalid("channelConnectionId must already be NFC.");
  if (reference.trim() !== reference) invalid("channelConnectionId must be trim-stable.");
  for (const scalar of reference) {
    const codePoint = scalar.codePointAt(0)!;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
      (codePoint & 0xffff) === 0xfffe ||
      (codePoint & 0xffff) === 0xffff
    ) {
      invalid("channelConnectionId contains a forbidden scalar.");
    }
  }
  return reference;
}

function opaqueReference(value: unknown, label: string, maximumScalars: number): string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > maximumScalars) {
    invalid(`${label} must contain 1 to ${maximumScalars} Unicode scalars.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid(`${label} contains an unpaired surrogate.`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      invalid(`${label} contains an unpaired surrogate.`);
    }
  }
  return value;
}

function canonicalUtcInstant(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    invalid(`${label} must be a canonical UTC instant.`);
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalid(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function closedRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key)) || keys.some((key) => !Object.hasOwn(record, key))) {
    invalid(`${label} must be recursively closed.`);
  }
  return record;
}

function compareUnicodeScalars(left: string, right: string): number {
  const leftScalars = Array.from(left, (value) => value.codePointAt(0)!);
  const rightScalars = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftScalars.length, rightScalars.length); index += 1) {
    if (leftScalars[index] !== rightScalars[index]) return leftScalars[index]! - rightScalars[index]!;
  }
  return leftScalars.length - rightScalars.length;
}

function invalid(message: string): never {
  throw new InventoryDomainError(message);
}
