import {
  createTransientProjectionError,
  type ProjectorHandler,
  type ProjectorHandlerMap,
} from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { PayoutReviewHoldServices } from "../../api/payout-review-hold-runtime";

const MIGRATED_BADGE_REASON = "Migrated manual-payout-review badge";

export type CommittedManualPayoutReviewBadgeReader = (accountId: AccountId) => Promise<boolean>;

/**
 * Converges each account's Payout Review Hold to its committed Identity manual-payout-review badge,
 * independently of the risk-source projection's checkpoint.
 * Every badge event re-reads the current badge rather than following the event's direction, so a
 * replay from origin appends nothing; an operator or risk-alert decision is never overridden.
 */
export function buildPayoutReviewHoldMigrationHandlers(
  readCommittedBadge: CommittedManualPayoutReviewBadgeReader | undefined,
  holds: PayoutReviewHoldServices,
): ProjectorHandlerMap {
  const converge: ProjectorHandler = async (event, invocation) => {
    if ((event.data as { badgeKey?: unknown }).badgeKey !== "manual-payout-review") return;
    const accountId = extractIdFromStreamId(event.streamId, "identity.account-") as AccountId;
    let badged: boolean;
    try {
      if (!readCommittedBadge) throw new Error("Committed Identity badge reader is not mounted.");
      badged = await readCommittedBadge(accountId);
    } catch (cause) {
      // Source availability is not a poison event or a negative badge decision.
      throw createTransientProjectionError(`Cannot read committed payout review badge for '${accountId}'.`, { cause });
    }
    invocation?.throwIfLeaseLost?.();
    const hold = await holds.get(accountId);
    if (hold.hasNonMigrationEvent || hold.active === badged) return;
    const context: EventStoreContext = {
      tenantId: event.tenantId,
      audit: { performedByUserId: "usr_settlement_system" as never, forAccountId: accountId },
      trace: event.trace,
    };
    const command = {
      accountId,
      reason: MIGRATED_BADGE_REASON,
      source: "badge-migration" as const,
      sourceReference: event.id,
    };
    if (badged) await holds.place(command, context);
    else await holds.release(command, context);
  };
  return {
    "identity.account.badge-assigned": converge,
    "identity.account.badge-removed": converge,
  };
}
