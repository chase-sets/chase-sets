import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { getObservabilityRuntime } from "@chase-sets/observability";
import {
  MARKETPLACE_OFFER_LIFECYCLE_ANCHOR_EVENT_TYPE,
  MARKETPLACE_OFFER_LIFECYCLE_EVENT_TYPES,
  type MarketplaceOfferLifecycleAdmission,
} from "@chase-sets/marketplace/server";
import { createEventConsumerAdmission } from "@chase-sets/platform-runtime/worker-event-capability";

/**
 * Pause, Resume and Withdraw open only when `CHASE_SETS_OFFER_LIFECYCLE_OPEN` is set and every platform
 * worker that can still be running since the latest deployment quiesce reads the lifecycle events, so an
 * old worker can never checkpoint past them.
 */
export function createOfferLifecycleAdmission(
  input: Readonly<{ open: boolean; db?: PgQueryable }>,
): MarketplaceOfferLifecycleAdmission {
  const admission = createEventConsumerAdmission({
    open: input.open,
    ...(input.db ? { db: input.db } : {}),
    requirement: {
      anchorEventType: MARKETPLACE_OFFER_LIFECYCLE_ANCHOR_EVENT_TYPE,
      requiredEventTypes: MARKETPLACE_OFFER_LIFECYCLE_EVENT_TYPES,
    },
  });
  return {
    async check() {
      const decision = await admission.check();
      if (!decision.admitted) {
        getObservabilityRuntime().logger.info("offer_lifecycle_closed_refusal", {
          type: "offer_lifecycle_closed_refusal",
          reason: decision.reason,
          workerIds: decision.workerIds ?? [],
        });
      }
      return decision;
    },
  };
}
