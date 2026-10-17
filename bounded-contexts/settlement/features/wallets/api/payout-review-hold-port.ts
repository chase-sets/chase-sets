import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { PayoutReviewHoldServices } from "./payout-review-hold-runtime";

/**
 * Settlement's side of Platform Operations' `payoutReviewHoldCrossContext` host port: the risk-alert
 * action places a `risk-alert` hold through this function, and Settlement re-checks the operator's
 * `payout-review-holds.manage` grant itself rather than trusting the calling context.
 */
export function createSettlementPayoutReviewHoldPort(resolveHolds: () => PayoutReviewHoldServices | undefined) {
  return {
    placeRiskAlertHold: async (
      input: Readonly<{
        accountId: string;
        reason: string;
        sourceReference: string;
        actorPermissions: readonly string[];
      }>,
      context: EventStoreContext,
    ) => {
      const holds = resolveHolds();
      if (!holds) throw new Error("Settlement services are not composed on this host.");
      return holds.place(
        {
          accountId: input.accountId as AccountId,
          reason: input.reason,
          source: "risk-alert",
          sourceReference: input.sourceReference,
          actorPermissions: input.actorPermissions,
        },
        context,
      );
    },
  };
}
