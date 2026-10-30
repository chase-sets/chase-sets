import type { EventStore } from "@chase-sets/event-core/event-store";
import { marketplaceAttemptBinding, marketplaceAttemptStream, completedMarketplaceAttemptSchema } from "./attempt";
import { readMarketplaceRecoveryHistory } from "../domain/history";
import {
  marketplaceMutationRecoveryResultSchema,
  type MarketplaceMutationRecoveryResult,
  type MarketplaceMutationKind,
} from "../domain/contracts";
import {
  offerAttemptResultSchema,
  offerAcceptanceResultSchema,
  offerPriceAttemptResultSchema,
} from "../../offers/api/attempt-result";
import { offerPolicyAttemptResultSchema } from "../../offer-policy/api/attempt-result";
import { withMarketplaceAttemptReceipt } from "./receipt";

export function createMarketplaceMutationLookup(eventStore: Pick<EventStore, "readStream">) {
  return async (input: {
    attemptId: string;
    accountId: string;
    mutationKind: MarketplaceMutationKind;
    target: MarketplaceMutationRecoveryResult["target"];
    requestHash: string;
  }): Promise<MarketplaceMutationRecoveryResult> => {
    const binding = marketplaceAttemptBinding({
      attemptId: input.attemptId,
      accountId: input.accountId,
      mutationKind: input.mutationKind,
      target: input.target,
      request: null,
    });
    const notObserved: MarketplaceMutationRecoveryResult = {
      ...binding,
      canonicalRequestHash: input.requestHash,
      ownerStatus: "not-observed",
    };
    const resultSchema =
      input.mutationKind === "offer.accept"
        ? offerAcceptanceResultSchema
        : input.mutationKind === "offer-policy.command"
          ? offerPolicyAttemptResultSchema
          : input.mutationKind === "offer.update-price"
            ? offerPriceAttemptResultSchema
            : offerAttemptResultSchema;
    const completedSchema = completedMarketplaceAttemptSchema<unknown>(resultSchema);
    let wrongOwner = false;
    const reader = {
      readStream: async (request: Parameters<EventStore["readStream"]>[0]) => {
        const events = await eventStore.readStream(request);
        if (events.some((event) => event.forAccountId !== input.accountId)) wrongOwner = true;
        return events;
      },
    };
    const history = await readMarketplaceRecoveryHistory<MarketplaceMutationRecoveryResult | null>(
      reader,
      marketplaceAttemptStream(binding),
      null,
      (state, event) => {
        if (state || event.eventType !== "marketplace.mutation-attempt.completed")
          throw new Error("Invalid attempt history.");
        const completed = completedSchema.parse(event.payload);
        if (completed.recovery.ownerStatus !== "committed" || !completed.recovery.ownerReceipt)
          throw new Error("Invalid receipt.");
        return withMarketplaceAttemptReceipt(completed.recovery, event);
      },
    );
    if (wrongOwner) return notObserved;
    if (!history.complete) return { ...notObserved, ownerStatus: "ambiguous", reason: "history-incomplete" };
    const prior = history.state;
    if (
      !prior ||
      prior.actorBinding.accountId !== input.accountId ||
      prior.mutationKind !== input.mutationKind ||
      prior.attemptKeyFingerprint !== binding.attemptKeyFingerprint ||
      prior.target.kind !== input.target.kind ||
      prior.target.id !== input.target.id ||
      prior.canonicalRequestHash !== input.requestHash
    )
      return notObserved;
    return prior;
  };
}
