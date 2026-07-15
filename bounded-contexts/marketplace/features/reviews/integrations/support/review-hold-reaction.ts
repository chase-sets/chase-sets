import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ReviewDirection } from "../../domain/review-hold";

type SupportLifecycleEvent = Readonly<{
  tenantId: EventStoreContext["tenantId"];
  audit: EventStoreContext["audit"];
  trace: EventStoreContext["trace"];
  data: Readonly<{
    supportRequestId: string;
    orderId: string;
    openedAt?: string;
    cancelledAt?: string;
    resolution?: Readonly<{ resolvedAt: string }>;
    reviewDirections?: readonly ReviewDirection[];
  }>;
}>;

export type ReviewHoldReactionDeps = Readonly<{
  recordSupportRequestOpened: (
    params: Readonly<{
      orderId: string;
      supportRequestId: string;
      openedAt: string;
      directions?: readonly ReviewDirection[];
    }>,
    context: EventStoreContext,
  ) => Promise<unknown>;
  recordSupportRequestTerminal: (
    params: Readonly<{
      orderId: string;
      supportRequestId: string;
      terminalAt: string;
      terminalStatus: "resolved" | "cancelled";
    }>,
    context: EventStoreContext,
  ) => Promise<unknown>;
}>;

function eventContext(event: SupportLifecycleEvent): EventStoreContext {
  return { tenantId: event.tenantId, audit: event.audit, trace: event.trace };
}

export function buildReviewHoldReactionHandlers(deps: ReviewHoldReactionDeps): ProjectorHandlerMap {
  return {
    "support.support-request.opened": async (event) => {
      const typedEvent = event as unknown as SupportLifecycleEvent;
      const { supportRequestId, orderId, openedAt, reviewDirections } = typedEvent.data;
      if (!openedAt) {
        return;
      }
      await deps.recordSupportRequestOpened(
        { orderId, supportRequestId, openedAt, ...(reviewDirections ? { directions: reviewDirections } : {}) },
        eventContext(typedEvent),
      );
    },
    "support.support-request.resolved": async (event) => {
      const typedEvent = event as unknown as SupportLifecycleEvent;
      const { supportRequestId, orderId, resolution } = typedEvent.data;
      if (!resolution?.resolvedAt) {
        return;
      }
      await deps.recordSupportRequestTerminal(
        { orderId, supportRequestId, terminalAt: resolution.resolvedAt, terminalStatus: "resolved" },
        eventContext(typedEvent),
      );
    },
    "support.support-request.cancelled": async (event) => {
      const typedEvent = event as unknown as SupportLifecycleEvent;
      const { supportRequestId, orderId, cancelledAt } = typedEvent.data;
      if (!cancelledAt) {
        return;
      }
      await deps.recordSupportRequestTerminal(
        { orderId, supportRequestId, terminalAt: cancelledAt, terminalStatus: "cancelled" },
        eventContext(typedEvent),
      );
    },
  };
}
