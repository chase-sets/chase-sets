import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CatalogMergeCandidateReviewActor } from "../domain/catalog-merge-candidate";

export function sourceObservationStreamId(observationId: string): string {
  return `catalog.source-observation-${observationId}`;
}

export function catalogMergeCandidateStreamId(candidateId: string): string {
  return `catalog.merge-candidate-${candidateId}`;
}

export function catalogMergeCandidateReviewActor(context: EventStoreContext): CatalogMergeCandidateReviewActor {
  return {
    userId: context.audit.performedByUserId ? String(context.audit.performedByUserId) : null,
    accountId: context.audit.forAccountId ? String(context.audit.forAccountId) : null,
  };
}
