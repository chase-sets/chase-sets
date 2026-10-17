import type { ProjectorHandler, ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { PayoutReviewHoldServices } from "../../api/payout-review-hold-runtime";
import { readManualPayoutReviewBadge } from "./account-risk-source-projection";

const MIGRATED_BADGE_REASON = "Migrated manual-payout-review badge";

/**
 * Converges each account's Payout Review Hold to its current Identity manual-payout-review badge, as the
 * unchanged version-1 identity risk-source subscription (which runs before this one) projected it.
 * Every badge event re-reads the current badge rather than following the event's direction, so a
 * replay from origin appends nothing; an operator or risk-alert decision is never overridden.
 */
export function buildPayoutReviewHoldMigrationHandlers(
  db: PgQueryable,
  holds: PayoutReviewHoldServices,
): ProjectorHandlerMap {
  const converge: ProjectorHandler = async (event) => {
    if ((event.data as { badgeKey?: unknown }).badgeKey !== "manual-payout-review") return;
    const accountId = extractIdFromStreamId(event.streamId, "identity.account-") as AccountId;
    const badged = await readManualPayoutReviewBadge(db, accountId);
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
