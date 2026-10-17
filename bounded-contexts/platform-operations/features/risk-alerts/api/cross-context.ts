import type { EventStoreContext } from "@chase-sets/event-core/storage";

export type PayoutReviewHoldCrossContextPort = Readonly<{
  placeRiskAlertHold: (
    input: { accountId: string; reason: string; sourceReference: string; actorPermissions: readonly string[] },
    context: EventStoreContext,
  ) => Promise<unknown>;
}>;
