import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { PayoutReviewHoldServices } from "../../api/payout-review-hold-runtime";

export function buildPayoutReviewHoldMigrationHandlers(services: PayoutReviewHoldServices): ProjectorHandlerMap {
  return {
    "identity.account.badge-assigned": async (event) => {
      const data = event.data as { badgeKey?: string };
      if (data.badgeKey !== "manual-payout-review") return;
      const accountId = extractIdFromStreamId(event.streamId, "identity.account-") as never;
      const context: EventStoreContext = {
        tenantId: event.tenantId,
        audit: { performedByUserId: event.audit.performedByUserId, forAccountId: accountId },
        trace: event.trace,
      };
      await services.place(
        {
          accountId,
          reason: "Migrated manual-payout-review badge",
          source: "badge-migration",
          sourceReference: event.id,
        },
        context,
      );
    },
    "identity.account.badge-removed": async (event) => {
      const data = event.data as { badgeKey?: string };
      if (data.badgeKey !== "manual-payout-review") return;
      const accountId = extractIdFromStreamId(event.streamId, "identity.account-") as never;
      const context: EventStoreContext = {
        tenantId: event.tenantId,
        audit: { performedByUserId: event.audit.performedByUserId, forAccountId: accountId },
        trace: event.trace,
      };
      await services.release(
        {
          accountId,
          reason: "Migrated manual-payout-review badge",
          source: "badge-migration",
          sourceReference: event.id,
        },
        context,
      );
    },
  };
}
