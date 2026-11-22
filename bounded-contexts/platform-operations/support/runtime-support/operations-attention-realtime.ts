import type { ProjectionHandlerSet, ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { withOperationsAttentionRealtimeInvalidation } from "../../features/operations-attention-queue/api/realtime-invalidation";
import type { OperationsAttentionSourceId } from "../../features/operations-attention-queue/read-model/ordering";

// The projection whose rows feed the attention queue's support source. The
// support runtime's other projections (evidence cleanup, transactional email)
// do not change the queue.
export const SUPPORT_REQUEST_QUEUE_PROJECTION = "support-request-projection";

// Composition seam: each queue source's projection keeps its own slice, and the
// root adds the queue's realtime invalidation to it here.
export function publishOperationsAttentionChanges(
  sets: readonly ProjectionHandlerSet[],
  db: PgQueryable,
  source: OperationsAttentionSourceId,
  include: (set: ProjectionHandlerSet) => boolean = () => true,
): ProjectionHandlerSet[] {
  return sets.map((set) =>
    include(set)
      ? {
          ...set,
          handlers: withOperationsAttentionRealtimeInvalidation(set.handlers, db, {
            projectionName: set.projectionName,
            source,
          }),
        }
      : set,
  );
}

// The same seam for a cross-context subscription's handlers. The outbox keys a
// patch by projection name and source position, and each source context counts
// positions on its own, so the name carries the source context.
export function publishOperationsAttentionSubscriptionChanges(
  handlers: ProjectorHandlerMap,
  db: PgQueryable,
  input: Readonly<{ sourceContextName: string; projectionName: string; source: OperationsAttentionSourceId }>,
): ProjectorHandlerMap {
  return withOperationsAttentionRealtimeInvalidation(handlers, db, {
    projectionName: `${input.sourceContextName}.${input.projectionName}`,
    source: input.source,
  });
}
