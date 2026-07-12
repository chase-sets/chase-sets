import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildPlatformOperationsPublicDocReviewProjectionHandlers } from "../read-model/projection";
import { getPendingPublicDocReview, listPendingPublicDocReviews } from "../read-model/queries";

export type PublicDocReviewServices = Readonly<{
  listPending: () => ReturnType<typeof listPendingPublicDocReviews>;
  confirm: (
    identity: Readonly<{ locale: string; articleSlug: string; policyKey: string; operatorUserId: string }>,
    context: EventStoreContext,
  ) => Promise<boolean>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createPublicDocReviewRuntime(
  deps: Readonly<{ db: PgQueryable; eventStore: EventStore }>,
): PublicDocReviewServices {
  return {
    listPending: () => listPendingPublicDocReviews(deps.db),
    confirm: async (identity, context) => {
      const pending = await getPendingPublicDocReview(deps.db, identity);
      if (!pending) return false;
      const confirmedAt = new Date().toISOString();
      await deps.eventStore.appendToStream({
        streamId:
          `platform-operations.public-doc-review-${identity.locale}-${identity.articleSlug}-${identity.policyKey}` as never,
        expectedVersion: "any",
        events: [
          {
            eventType: "platform-operations.public-doc-article-review.confirmed",
            payload: {
              locale: identity.locale,
              articleSlug: identity.articleSlug,
              policyKey: identity.policyKey,
              policyRevisionEventId: pending.policyRevisionEventId,
              operatorUserId: identity.operatorUserId,
              confirmedAt,
            },
          },
        ],
        context,
      });
      return true;
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "platform-operations-public-doc-review-confirmation-projection",
        handlers: buildPlatformOperationsPublicDocReviewProjectionHandlers(deps.db),
        streamPrefixes: ["platform-operations.public-doc-review-"],
      }),
    ],
  };
}
