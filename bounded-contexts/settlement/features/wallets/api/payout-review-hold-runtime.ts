import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  decidePayoutReviewHold,
  evolvePayoutReviewHold,
  initialPayoutReviewHoldState,
  payoutReviewHoldStreamId,
  type PayoutReviewHoldEvent,
  type PayoutReviewHoldView,
  type PayoutReviewHoldState,
} from "../domain/payout-review-hold";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

export type PayoutReviewHoldServices = Readonly<{
  get: (accountId: AccountId) => Promise<PayoutReviewHoldView>;
  place: (
    input: {
      accountId: AccountId;
      reason: string;
      source: "operator" | "risk-alert" | "badge-migration";
      sourceReference?: string | null;
      actorPermissions?: readonly string[];
    },
    context: EventStoreContext,
  ) => Promise<{ outcome: "placed" | "noop"; version: number }>;
  release: (
    input: {
      accountId: AccountId;
      reason: string;
      source: "operator" | "risk-alert" | "badge-migration";
      sourceReference?: string | null;
      actorPermissions?: readonly string[];
    },
    context: EventStoreContext,
  ) => Promise<{ outcome: "released" | "noop"; version: number }>;
}>;

export function createPayoutReviewHoldRuntime(deps: { eventStore: EventStore }): PayoutReviewHoldServices {
  const { commandHandler, repository } = createAggregateCommandHandler<
    PayoutReviewHoldState,
    Parameters<typeof decidePayoutReviewHold>[1],
    PayoutReviewHoldEvent
  >({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<PayoutReviewHoldEvent>(),
    initialState: () => initialPayoutReviewHoldState,
    evolve: evolvePayoutReviewHold,
    decide: decidePayoutReviewHold,
  });
  async function run(
    input: {
      accountId: AccountId;
      reason: string;
      source: "operator" | "risk-alert" | "badge-migration";
      sourceReference?: string | null;
      actorPermissions?: readonly string[];
    },
    type: "PlacePayoutReviewHold" | "ReleasePayoutReviewHold",
    context: EventStoreContext,
  ) {
    if (input.source === "risk-alert" && !input.actorPermissions?.includes("payout-review-holds.manage")) {
      throw new Error("Payout review hold permission is required.");
    }
    let result: Awaited<ReturnType<typeof commandHandler>> | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        result = await commandHandler({
          streamId: payoutReviewHoldStreamId(input.accountId),
          command: { type, ...input },
          context,
        });
        break;
      } catch (error) {
        if (
          !(error && typeof error === "object" && (error as { code?: unknown }).code === "concurrency_conflict") ||
          attempt === 3
        )
          throw error;
      }
    }
    if (!result) throw new Error("Payout review hold command did not complete.");
    const outcome: "placed" | "released" | "noop" =
      result.newEvents[0]?.type === "settlement.payout-review-hold.placed"
        ? "placed"
        : result.newEvents[0]?.type === "settlement.payout-review-hold.released"
          ? "released"
          : "noop";
    return { outcome, version: result.version };
  }
  return {
    get: async (accountId) => {
      const streamId = payoutReviewHoldStreamId(accountId);
      const loaded = await repository.load(streamId);
      const latest = loaded.storedEvents.at(-1);
      const payload = latest?.payload as { reason?: unknown; source?: unknown; sourceReference?: unknown } | undefined;
      return {
        ...loaded.state,
        reason: typeof payload?.reason === "string" ? payload.reason : null,
        source:
          payload?.source === "operator" || payload?.source === "risk-alert" || payload?.source === "badge-migration"
            ? payload.source
            : null,
        sourceReference: typeof payload?.sourceReference === "string" ? payload.sourceReference : null,
        actorUserId: latest?.performedByUserId ?? null,
        occurredAt: latest?.occurredAt ?? null,
        version: loaded.version,
      } satisfies PayoutReviewHoldView;
    },
    place: async (input, context) => {
      const result = await run(input, "PlacePayoutReviewHold", context);
      return { outcome: result.outcome === "released" ? "noop" : result.outcome, version: result.version };
    },
    release: async (input, context) => {
      const result = await run(input, "ReleasePayoutReviewHold", context);
      return { outcome: result.outcome === "placed" ? "noop" : result.outcome, version: result.version };
    },
  };
}
