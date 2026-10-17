import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreError } from "@chase-sets/event-core/event-store";
import type { InventoryChannelStockAllocationSetPayload } from "@chase-sets/event-core/public-event-payloads/inventory";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { InventoryRuntimeDeps } from "../../../support/runtime-support";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import {
  absentChannelStockAllocation,
  CHANNEL_STOCK_ALLOCATION_EVENT_TYPE,
  CHANNEL_STOCK_ALLOCATION_EVENT_VERSION,
  channelStockAllocationStreamId,
  evolveChannelStockAllocation,
  normalizeSetChannelStockAllocationCommand,
  type ChannelStockAllocation,
  type SetChannelStockAllocationCommand,
} from "../domain/allocation";
import { channelStockAllocationEventCodec } from "../domain/codec";
import { buildInventoryChannelStockAllocationProjectionHandlers } from "../read-model/projection";
import { readChannelStockAllocation } from "../read-model/queries";
import type {
  ChannelStockAllocationHistoryFailure,
  ChannelStockAllocationHistoryFailureReason,
  SetChannelStockAllocation,
  SetChannelStockAllocationResult,
} from "./contracts";

export type InventoryChannelStockAllocationServices = Readonly<{
  set(command: SetChannelStockAllocationCommand, context: EventStoreContext): Promise<SetChannelStockAllocationResult>;
  bind(context: EventStoreContext): SetChannelStockAllocation;
  read(input: Readonly<{ accountId: string; inventoryItemId: string }>): Promise<ChannelStockAllocation>;
  readAuthoritative(
    input: Readonly<{ accountId: string; inventoryItemId: string }>,
  ): Promise<ChannelStockAllocation | ChannelStockAllocationHistoryFailure>;
  readonly projectors: readonly ProjectionHandlerSet[];
}>;

type Rehydration =
  | Readonly<{ kind: "valid"; allocation: ChannelStockAllocation }>
  | Readonly<{ kind: "invalid"; failure: ChannelStockAllocationHistoryFailure }>;

export function createInventoryChannelStockAllocationRuntime(
  deps: InventoryRuntimeDeps,
  options: Readonly<{ now?: () => Date }> = {},
): InventoryChannelStockAllocationServices {
  const now = options.now ?? (() => new Date());

  async function readAuthoritative(
    input: Readonly<{ accountId: string; inventoryItemId: string }>,
  ): Promise<ChannelStockAllocation | ChannelStockAllocationHistoryFailure> {
    const command = normalizeSetChannelStockAllocationCommand({
      ...input,
      mode: "shared-pool",
      partitions: [],
      expectedRevision: 0,
    });
    const result = await rehydrate(deps, command.accountId, command.inventoryItemId);
    return result.kind === "valid" ? result.allocation : result.failure;
  }

  async function set(
    rawCommand: SetChannelStockAllocationCommand,
    context: EventStoreContext,
  ): Promise<SetChannelStockAllocationResult> {
    // All command and authorization rejection classes are decided before the
    // authoritative stream is read, so malformed input has zero I/O effect.
    const command = normalizeSetChannelStockAllocationCommand(rawCommand);
    if (String(context.audit.forAccountId) !== command.accountId) {
      throw new InventoryDomainError("Channel Stock Allocation context must match the command account.");
    }

    const initial = await rehydrate(deps, command.accountId, command.inventoryItemId);
    if (initial.kind === "invalid") return initial.failure;
    if (initial.allocation.revision !== command.expectedRevision) {
      return revisionConflict(command.expectedRevision, initial.allocation.revision);
    }

    const setAt = now().toISOString();
    const payload: InventoryChannelStockAllocationSetPayload = {
      eventVersion: CHANNEL_STOCK_ALLOCATION_EVENT_VERSION,
      accountId: command.accountId,
      inventoryItemId: command.inventoryItemId,
      mode: command.mode,
      partitions: command.partitions,
      setAt,
    };
    const encoded = channelStockAllocationEventCodec.encode({
      type: CHANNEL_STOCK_ALLOCATION_EVENT_TYPE,
      data: payload,
    });
    try {
      const stored = await deps.eventStore.appendToStream({
        streamId: channelStockAllocationStreamId(command.inventoryItemId),
        expectedVersion: command.expectedRevision,
        wakeSourceContextName: "inventory",
        events: [{ ...encoded, occurredAt: setAt as IsoUtcTimestamp }],
        context,
      });
      const revision = stored[0]!.streamVersion;
      return {
        kind: "applied",
        allocation: evolveChannelStockAllocation(initial.allocation, payload, revision),
      };
    } catch (error) {
      if (isConcurrencyConflict(error)) {
        const concurrent = await rehydrate(deps, command.accountId, command.inventoryItemId);
        return concurrent.kind === "invalid"
          ? concurrent.failure
          : revisionConflict(command.expectedRevision, concurrent.allocation.revision);
      }
      throw error;
    }
  }

  return {
    set,
    bind: (context) => (command) => set(command, context),
    read: (input) => readChannelStockAllocation(deps.db, input),
    readAuthoritative,
    projectors: [
      createProjectionHandlerSet({
        projectionName: "inventory-channel-stock-allocation-projection",
        handlers: buildInventoryChannelStockAllocationProjectionHandlers(deps.db),
      }),
    ],
  };
}

async function rehydrate(deps: InventoryRuntimeDeps, accountId: string, inventoryItemId: string): Promise<Rehydration> {
  const streamId = channelStockAllocationStreamId(inventoryItemId);
  let events: readonly StoredEvent[];
  try {
    events = await readCompleteStream(deps.eventStore, { streamId });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("inclusive read expected") || error.message.includes("non-contiguous stream versions"))
    ) {
      return invalid("wrong-order-or-version", 0);
    }
    throw error;
  }
  let state = absentChannelStockAllocation(accountId, inventoryItemId);
  for (let index = 0; index < events.length; index += 1) {
    const stored = events[index]!;
    if (stored.streamVersion !== index + 1) return invalid("wrong-order-or-version", index);
    if (stored.eventType !== CHANNEL_STOCK_ALLOCATION_EVENT_TYPE) return invalid("unknown-event", index);
    const candidate = stored.payload as Record<string, unknown>;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      candidate.eventVersion !== CHANNEL_STOCK_ALLOCATION_EVENT_VERSION
    ) {
      return invalid("unsupported-event-version", index);
    }
    let event;
    try {
      event = channelStockAllocationEventCodec.decode(stored);
    } catch {
      return invalid(index === events.length - 1 && events.length > 1 ? "invalid-tail" : "inconsistent-history", index);
    }
    if (
      event.data.accountId !== accountId ||
      event.data.inventoryItemId !== inventoryItemId ||
      stored.forAccountId !== accountId ||
      stored.occurredAt !== event.data.setAt ||
      stored.streamId !== streamId ||
      state.accountId !== event.data.accountId ||
      state.inventoryItemId !== event.data.inventoryItemId
    ) {
      return invalid(index === events.length - 1 && events.length > 1 ? "invalid-tail" : "inconsistent-history", index);
    }
    state = evolveChannelStockAllocation(state, event.data, stored.streamVersion);
  }
  return { kind: "valid", allocation: state };
}

function invalid(reason: ChannelStockAllocationHistoryFailureReason, eventIndex: number | null): Rehydration {
  return {
    kind: "invalid",
    failure: { kind: "refused", code: "channel-stock-allocation-history-invalid", reason, eventIndex },
  };
}

function revisionConflict(expectedRevision: number, actualRevision: number): SetChannelStockAllocationResult {
  return {
    kind: "refused",
    code: "channel-stock-allocation-revision-conflict",
    expectedRevision,
    actualRevision,
  };
}

function isConcurrencyConflict(error: unknown): error is EventStoreError {
  return !!error && typeof error === "object" && "code" in error && error.code === "concurrency_conflict";
}
