import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { SettlementDomainError } from "../../../../support/runtime-support/common";
import {
  createSettlementSupportHoldId,
  decideSupportHoldLifecycle,
  evolveSupportHoldLifecycle,
  initialSupportHoldLifecycleState,
  supportHoldLifecycleStreamId,
  type SupportHoldLifecycleCommand,
  type SupportHoldLifecycleEvent,
} from "./support-hold-lifecycle";
import type { SupportHoldLifecyclePort } from "./support-hold-lifecycle-reaction";

/** Manifest projection name for the settlement-owned support-hold lifecycle reaction. */
export const SETTLEMENT_SUPPORT_HOLD_LIFECYCLE_PROJECTION = "settlement-support-hold-lifecycle-projection";

const MAX_CONCURRENCY_RETRIES = 4;

function isConcurrencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "concurrency_conflict";
}

export type PlaceSupportHoldInput = Readonly<{
  supportRequestId: string;
  orderId: string;
  buyerAccountId: string;
  sellerAccountId: string;
  flowType: string;
  occurredAt: string;
}>;

export type ResolveSupportHoldInput = Readonly<{
  supportRequestId: string;
  resolutionType: string;
  occurredAt: string;
}>;

export type TerminalSupportHoldInput = Readonly<{
  supportRequestId: string;
  occurredAt: string;
}>;

/** What the fact emission produced, for observability and tests. */
export type SupportHoldLifecycleResult = Readonly<{
  outcome: "placed" | "released" | "consumed" | "noop";
  holdId: string;
}>;

/**
 * The runtime is exactly the reaction port: place/resolve/close/cancel a hold. It exposes
 * no read model and no local projector — the reaction is registered as a cross-context
 * subscription (see `index.ts`), mirroring the coverage-reservation reaction.
 */
export type SupportHoldLifecycleServices = SupportHoldLifecyclePort;

type SupportHoldLifecycleRuntimeDeps = Readonly<{
  eventStore: EventStore;
}>;

/**
 * Reaction seam that translates support-case lifecycle transitions into settlement-owned
 * support-hold facts. The aggregate is the authority; this runtime only turns each
 * transition into a command against the per-hold stream, keyed idempotently so
 * subscription replay and duplicate delivery emit each fact at most once.
 */
export function createSupportHoldLifecycleRuntime(deps: SupportHoldLifecycleRuntimeDeps): SupportHoldLifecycleServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<SupportHoldLifecycleEvent>(),
    initialState: () => initialSupportHoldLifecycleState,
    evolve: evolveSupportHoldLifecycle,
    decide: decideSupportHoldLifecycle,
  });

  async function runCommand(
    supportRequestId: string,
    command: SupportHoldLifecycleCommand,
    context: EventStoreContext,
  ): Promise<SupportHoldLifecycleResult> {
    const holdId = createSettlementSupportHoldId(supportRequestId);
    const streamId = supportHoldLifecycleStreamId(holdId);
    for (let attempt = 0; attempt < MAX_CONCURRENCY_RETRIES; attempt += 1) {
      try {
        const { newEvents } = await commandHandler({ streamId, command, context });
        const emitted = newEvents[0];
        if (!emitted) {
          return { outcome: "noop", holdId };
        }
        switch (emitted.type) {
          case "settlement.support-hold.placed.v1":
            return { outcome: "placed", holdId };
          case "settlement.support-hold.released.v1":
            return { outcome: "released", holdId };
          case "settlement.support-hold.consumed.v1":
            return { outcome: "consumed", holdId };
          default:
            return { outcome: "noop", holdId };
        }
      } catch (error) {
        if (!isConcurrencyConflict(error)) {
          throw error;
        }
      }
    }
    throw new SettlementDomainError(
      "Support hold lifecycle command could not be serialized after repeated concurrent writes.",
    );
  }

  return {
    placeHold: (input, context) => runCommand(input.supportRequestId, { type: "PlaceSupportHold", ...input }, context),
    resolveHold: (input, context) =>
      runCommand(input.supportRequestId, { type: "ResolveSupportHold", ...input }, context),
    closeHold: (input, context) => runCommand(input.supportRequestId, { type: "CloseSupportHold", ...input }, context),
    cancelHold: (input, context) =>
      runCommand(input.supportRequestId, { type: "CancelSupportHold", ...input }, context),
  };
}
