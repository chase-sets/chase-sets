import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";

type SupportLifecycleEvent = Readonly<{
  streamVersion: number;
  tenantId: EventStoreContext["tenantId"];
  audit: EventStoreContext["audit"];
  trace: EventStoreContext["trace"];
  data: Readonly<{
    supportRequestId: string;
    orderId: string;
    openedAt?: string;
    cancelledAt?: string;
    resolution?: Readonly<{
      responsibility?: unknown;
      resolutionType?: string | null;
      resolvedAt: string;
    }>;
  }>;
}>;

export type RecordReviewScoringSupportFact = (
  params: Readonly<{
    orderId: string;
    supportRequestId: string;
    sourceStreamVersion: number;
    status: "open" | "resolved" | "cancelled";
    responsibility?: unknown;
    resolutionType?: string | null;
    lifecycleAt: string;
  }>,
  context: EventStoreContext,
) => Promise<unknown>;

function eventContext(event: SupportLifecycleEvent): EventStoreContext {
  return { tenantId: event.tenantId, audit: event.audit, trace: event.trace };
}

export function buildReviewScoringReactionHandlers(deps: {
  recordSupportFact: RecordReviewScoringSupportFact;
}): ProjectorHandlerMap {
  return {
    "support.support-request.opened": async (event) => {
      const typedEvent = event as unknown as SupportLifecycleEvent;
      const { supportRequestId, orderId, openedAt } = typedEvent.data;
      if (!openedAt) return;
      await deps.recordSupportFact(
        {
          orderId,
          supportRequestId,
          sourceStreamVersion: typedEvent.streamVersion,
          status: "open",
          lifecycleAt: openedAt,
        },
        eventContext(typedEvent),
      );
    },
    "support.support-request.resolved": async (event) => {
      const typedEvent = event as unknown as SupportLifecycleEvent;
      const { supportRequestId, orderId, resolution } = typedEvent.data;
      if (!resolution?.resolvedAt) return;
      await deps.recordSupportFact(
        {
          orderId,
          supportRequestId,
          sourceStreamVersion: typedEvent.streamVersion,
          status: "resolved",
          ...(resolution.responsibility !== undefined ? { responsibility: resolution.responsibility } : {}),
          resolutionType: resolution.resolutionType ?? null,
          lifecycleAt: resolution.resolvedAt,
        },
        eventContext(typedEvent),
      );
    },
    "support.support-request.cancelled": async (event) => {
      const typedEvent = event as unknown as SupportLifecycleEvent;
      const { supportRequestId, orderId, cancelledAt } = typedEvent.data;
      if (!cancelledAt) return;
      await deps.recordSupportFact(
        {
          orderId,
          supportRequestId,
          sourceStreamVersion: typedEvent.streamVersion,
          status: "cancelled",
          lifecycleAt: cancelledAt,
        },
        eventContext(typedEvent),
      );
    },
  };
}
