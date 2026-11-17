import type { MarketplaceEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { upsertOutcomeFact } from "../../read-model/outcome-fact-projection";

export function buildMarketplaceOutcomeFactProjectionHandlers(): ProjectorHandlerMap {
  return defineProjectorHandlers<Pick<MarketplaceEventPayloads,
    "marketplace.listing.published" | "marketplace.offer.accepted" | "marketplace.review.submitted"
  >>({
    "marketplace.listing.published": async (event, context) => {
      const data = event.data;
      const native = data.listingId && data.sellerAccountId && data.publishedAt;
      const legacy = data.csatOutcomeFact;
      const fact = legacy && typeof legacy === "object" && !Array.isArray(legacy) ? legacy : null;
      const subject = fact?.subject;
      const legacySubject = subject && typeof subject === "object" && !Array.isArray(subject) ? subject : null;
      if (!native && !(fact?.outcomeCode === "listing.published" && fact.sourceContext === "marketplace" &&
        fact.subjectKind === "seller" && typeof fact.subjectAccountId === "string" && fact.subjectAccountId.trim() &&
        legacySubject?.entityType === "listing" && typeof legacySubject.entityId === "string" && legacySubject.entityId.trim() &&
        typeof fact.idempotencyKey === "string" && fact.idempotencyKey.trim() &&
        typeof fact.outcomeOccurredAt === "string" && Number.isFinite(Date.parse(fact.outcomeOccurredAt)))) return;
      await upsertOutcomeFact(context?.db as unknown as PgQueryable, {
        idempotencyKey: native ? `marketplace:listing.published:${data.listingId}` : fact!.idempotencyKey as string,
        outcomeCode: "listing.published",
        sourceContext: "marketplace",
        subjectAccountId: native ? data.sellerAccountId! : fact!.subjectAccountId as string,
        subjectKind: "seller",
        subjectEntityType: "listing",
        subjectEntityId: native ? data.listingId! : legacySubject!.entityId as string,
        outcomeOccurredAt: native ? data.publishedAt! : fact!.outcomeOccurredAt as string,
        sourceEventId: event.id,
        performedByUserId: event.audit.performedByUserId,
        authenticationMethod: null,
        reasonCode: null,
      });
    },
    "marketplace.offer.accepted": async (event, context) => {
      await upsertOutcomeFact(context?.db as unknown as PgQueryable, {
        idempotencyKey: `marketplace:offer.accepted:${event.data.offerId}`,
        outcomeCode: "offer.accepted",
        sourceContext: "marketplace",
        subjectAccountId: event.data.sellerAccountId,
        subjectKind: "seller",
        subjectEntityType: "offer",
        subjectEntityId: event.data.offerId,
        outcomeOccurredAt: event.data.acceptedAt,
        sourceEventId: event.id,
        performedByUserId: event.audit.performedByUserId,
        authenticationMethod: null,
        reasonCode: null,
      });
    },
    "marketplace.review.submitted": async (event, context) => {
      await upsertOutcomeFact(context?.db as unknown as PgQueryable, {
        idempotencyKey: `review:${event.data.reviewId}:received`,
        outcomeCode: "reputation.review-received",
        sourceContext: "marketplace",
        subjectAccountId: event.data.authorAccountId,
        subjectKind: event.data.authorRole,
        subjectEntityType: "review",
        subjectEntityId: event.data.reviewId,
        outcomeOccurredAt: event.data.submittedAt,
        sourceEventId: event.id,
        performedByUserId: event.audit.performedByUserId,
        authenticationMethod: null,
        reasonCode: null,
      });
    },
  });
}
