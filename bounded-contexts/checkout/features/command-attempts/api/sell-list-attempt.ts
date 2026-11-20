import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import { CheckoutDomainError, type SellListLineId } from "../../../support/runtime-support/common";
import {
  decideCheckoutSellList,
  evolveCheckoutSellList,
  type CheckoutSellListState,
  type CheckoutSellListEvent,
  type CheckoutSellListCommand,
} from "../../sell-list/domain/domain";
import type { AddCheckoutSellListLineInput } from "../../sell-list/api/runtime";
import {
  checkoutCommandAttemptActorBinding,
  checkoutCommandAttemptCompletedEvent,
  checkoutCommandAttemptFingerprint,
  checkoutCommandAttemptStreamId,
  readCheckoutCommandAttemptHistory,
  withCheckoutCommandAttemptReceipt,
  type CheckoutCommandAttemptHistory,
} from "./attempt-history";
import {
  isCheckoutCommandAttemptId,
  type CheckoutCommandAttemptResult,
  type CheckoutCartLineOutcome,
  type CheckoutSellListAttemptKind,
} from "./contracts";

export type SellListAttemptQuery = Readonly<{
  ownerKey: string;
  attemptId: string;
  kind: CheckoutSellListAttemptKind;
  target: string;
  requestHash: string;
}>;
export type SellListLineCommand =
  | Readonly<{ type: "add"; line: Omit<AddCheckoutSellListLineInput, "attemptId" | "requestHash"> }>
  | Readonly<{ type: "remove"; lineId: SellListLineId }>;
export type SellListAttemptRequest = SellListAttemptQuery &
  Readonly<{ commands: readonly SellListLineCommand[]; newLineLimit?: number }>;

export function createCheckoutSellListAttemptExecutor(
  deps: Readonly<{
    eventStore: EventStore;
    load: (streamId: string) => Promise<{ state: CheckoutSellListState; version: number }>;
    normalize: (
      line: Omit<AddCheckoutSellListLineInput, "attemptId" | "requestHash">,
    ) => Promise<Omit<AddCheckoutSellListLineInput, "attemptId" | "requestHash">>;
  }>,
) {
  const codec = createPassthroughDomainEventCodec<CheckoutSellListEvent>();
  function base(query: SellListAttemptQuery) {
    return {
      schemaVersion: 1 as const,
      kind: query.kind,
      fingerprint: checkoutCommandAttemptFingerprint(query),
      actorBinding: checkoutCommandAttemptActorBinding(query.ownerKey),
      target: query.target,
      requestHash: query.requestHash,
    };
  }
  function resolve(
    query: SellListAttemptQuery,
    history: Exclude<CheckoutCommandAttemptHistory, { kind: "absent" }>,
  ): CheckoutCommandAttemptResult {
    const binding = base(query);
    if (
      history.kind === "history-incomplete" ||
      history.result.kind !== query.kind ||
      history.result.target !== query.target ||
      history.result.actorBinding.kind !== binding.actorBinding.kind ||
      history.result.actorBinding.digest !== binding.actorBinding.digest
    ) {
      return { ...binding, ownerStatus: "ambiguous", reason: "history-incomplete" };
    }
    return history.result.requestHash === query.requestHash ? history.result : { ...binding, ownerStatus: "conflict" };
  }
  async function lookupSellListAttempt(query: SellListAttemptQuery): Promise<CheckoutCommandAttemptResult> {
    const history = await readCheckoutCommandAttemptHistory(deps.eventStore, base(query).fingerprint);
    return history.kind === "absent" ? { ...base(query), ownerStatus: "not-observed" } : resolve(query, history);
  }
  async function executeSellListAttempt(
    request: SellListAttemptRequest,
    context: EventStoreContext,
  ): Promise<CheckoutCommandAttemptResult> {
    if (
      !isCheckoutCommandAttemptId(request.attemptId) ||
      !/^[0-9a-f]{64}$/.test(request.requestHash) ||
      !request.ownerKey ||
      !request.target ||
      request.target.length > 128 ||
      !["sell-list-line", "sell-list-batch"].includes(request.kind) ||
      request.commands.length < 1 ||
      request.commands.length > 250
    ) {
      throw new CheckoutDomainError(
        "A bounded caller-created Sell List attempt is required.",
        "checkout_attempt_required",
      );
    }
    const binding = base(request);
    const attemptStreamId = checkoutCommandAttemptStreamId(binding.fingerprint);
    const prior = await readCheckoutCommandAttemptHistory(deps.eventStore, binding.fingerprint);
    if (prior.kind !== "absent") return resolve(request, prior);
    if (!deps.eventStore.appendToStreams) throw new Error("Sell List attempts require atomic multi-stream append.");
    const streamId = `checkout.sell-list-${request.ownerKey}`;
    for (let decision = 0; decision <= 2; decision += 1) {
      const loaded = await deps.load(streamId);
      if (loaded.state.sellerAccountId && loaded.state.sellerAccountId !== request.ownerKey)
        throw new CheckoutDomainError("Sell List owner changed.");
      let state = loaded.state;
      const events: CheckoutSellListEvent[] = [];
      const vector: CheckoutCartLineOutcome[] = [];
      function apply(command: CheckoutSellListCommand) {
        for (const event of decideCheckoutSellList(state, command)) {
          state = evolveCheckoutSellList(state, event);
          events.push(event);
        }
      }
      for (const [index, command] of request.commands.entries()) {
        const checkpoint = state;
        const eventCount = events.length;
        try {
          let lineId: SellListLineId;
          let status: "added" | "merged" | "removed";
          if (command.type === "remove") {
            lineId = command.lineId;
            if (state.lines.some((line) => line.lineId === lineId)) apply({ type: "RemoveSellListLine", lineId });
            status = "removed";
          } else {
            const normalized = await deps.normalize(command.line);
            if (normalized.sellerAccountId !== request.ownerKey)
              throw new Error("Sell List command owner does not match its attempt.");
            const existing = state.lines.find((line) =>
              normalized.lineType === "selected-offer" && normalized.offerId
                ? line.offerId === normalized.offerId
                : line.lineType === "product" &&
                  line.productId === normalized.productId &&
                  line.fallbackMode === normalized.fallbackMode &&
                  (line.minimumListingPriceAmount ?? null) === normalized.minimumListingPriceAmount,
            );
            lineId = existing?.lineId ?? (createId("sll") as SellListLineId);
            status = existing ? "merged" : "added";
            if (existing?.lineType === "product")
              apply({ type: "SetSellListLineQuantity", lineId, quantity: existing.quantity + normalized.quantity });
            else if (!existing) {
              if (request.newLineLimit !== undefined && state.lines.length >= request.newLineLimit)
                throw new CheckoutDomainError(
                  "Anonymous Sell List line limit exceeded.",
                  "anonymous_sell_list_limit_exceeded",
                );
              apply({
                ...normalized,
                type: "AddSellListLine",
                lineId,
                offerId: normalized.offerId ?? null,
                listingId: normalized.listingId ?? null,
                buyerAccountId: normalized.buyerAccountId ?? null,
                buyerDisplayName: normalized.buyerDisplayName ?? null,
                offerPriceAmount: normalized.offerPriceAmount ?? null,
                fallbackMode: normalized.fallbackMode ?? "none",
                minimumListingPriceAmount: normalized.minimumListingPriceAmount ?? null,
              });
            }
          }
          vector.push({
            index,
            command: command.type,
            outcome: "succeeded",
            lineId,
            status,
            version: 0,
            message: null,
          });
        } catch (error) {
          if (!(error instanceof CheckoutDomainError)) throw error;
          state = checkpoint;
          events.length = eventCount;
          vector.push({
            index,
            command: command.type,
            outcome: "error",
            lineId: command.type === "remove" ? command.lineId : null,
            status: null,
            version: 0,
            message: error.message.slice(0, 512),
          });
        }
      }
      const result: CheckoutCommandAttemptResult = {
        ...binding,
        ownerStatus: "committed",
        vector: vector.map((line) => ({ ...line, version: loaded.version + events.length })),
      };
      try {
        const appended = await deps.eventStore.appendToStreams([
          ...(events.length || loaded.version
            ? [
                {
                  streamId,
                  expectedVersion: loaded.version || ("no_stream" as const),
                  context,
                  events: events.map(codec.encode),
                },
              ]
            : []),
          {
            streamId: attemptStreamId,
            expectedVersion: "no_stream",
            context,
            events: [checkoutCommandAttemptCompletedEvent(result)],
          },
        ]);
        recordCommittedEvents(appended.flatMap((entry) => entry.storedEvents));
        return withCheckoutCommandAttemptReceipt(
          result,
          appended.find((entry) => entry.streamId === attemptStreamId)?.storedEvents[0],
        );
      } catch (error) {
        if ((error as { code?: unknown })?.code !== "concurrency_conflict") throw error;
        const winner = await readCheckoutCommandAttemptHistory(deps.eventStore, binding.fingerprint);
        if (winner.kind !== "absent") return resolve(request, winner);
      }
    }
    const result: CheckoutCommandAttemptResult = { ...binding, ownerStatus: "failed-safe", reason: "cart-changed" };
    try {
      const appended = await deps.eventStore.appendToStreams([
        {
          streamId: attemptStreamId,
          expectedVersion: "no_stream",
          context,
          events: [checkoutCommandAttemptCompletedEvent(result)],
        },
      ]);
      recordCommittedEvents(appended.flatMap((entry) => entry.storedEvents));
      return withCheckoutCommandAttemptReceipt(result, appended[0]?.storedEvents[0]);
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "concurrency_conflict") throw error;
      const winner = await readCheckoutCommandAttemptHistory(deps.eventStore, binding.fingerprint);
      if (winner.kind === "absent") throw error;
      return resolve(request, winner);
    }
  }
  return { executeSellListAttempt, lookupSellListAttempt };
}
