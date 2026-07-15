import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  PlaceSupportHoldInput,
  ResolveSupportHoldInput,
  SupportHoldLifecycleResult,
  TerminalSupportHoldInput,
} from "./support-hold-lifecycle-runtime";

/**
 * The narrow slice of the SupportHoldLifecycle runtime this reaction drives. Declaring it
 * as a port keeps the reaction unit-testable with a fake and inverts the compile dependency
 * onto the aggregate that owns fact emission (never reinvent). The concrete runtime
 * satisfies this structurally.
 */
export type SupportHoldLifecyclePort = Readonly<{
  placeHold: (input: PlaceSupportHoldInput, context: EventStoreContext) => Promise<SupportHoldLifecycleResult>;
  resolveHold: (input: ResolveSupportHoldInput, context: EventStoreContext) => Promise<SupportHoldLifecycleResult>;
  closeHold: (input: TerminalSupportHoldInput, context: EventStoreContext) => Promise<SupportHoldLifecycleResult>;
  cancelHold: (input: TerminalSupportHoldInput, context: EventStoreContext) => Promise<SupportHoldLifecycleResult>;
}>;

function eventContext(event: {
  tenantId: EventStoreContext["tenantId"];
  audit: EventStoreContext["audit"];
  trace: EventStoreContext["trace"];
}): EventStoreContext {
  return { tenantId: event.tenantId, audit: event.audit, trace: event.trace };
}

/**
 * Reaction — translates the support-request case lifecycle (hosted by Platform Operations
 * under the `support.*` stream) into settlement support-hold facts. Settlement owns whether
 * a case's hold is placed and how it terminates; this projection is only the seam that turns
 * each case transition into the matching hold command. It writes no read-model table
 * (side-effect-only); every effect is idempotent through the SupportHoldLifecycle aggregate.
 *
 * `escalated` is intentionally unhandled: escalation moves the case forward but neither
 * places nor releases the hold, and its own notification is owned by the dispute matrix.
 */
export function buildSupportHoldLifecycleReactionHandlers(port: SupportHoldLifecyclePort): ProjectorHandlerMap {
  return {
    "support.support-request.opened": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        orderId: string;
        buyerAccountId: string;
        sellerAccountId: string;
        flowType: string;
        openedAt: string;
      };
      await port.placeHold(
        {
          supportRequestId: data.supportRequestId,
          orderId: data.orderId,
          buyerAccountId: data.buyerAccountId,
          sellerAccountId: data.sellerAccountId,
          flowType: data.flowType,
          occurredAt: data.openedAt,
        },
        eventContext(event),
      );
    },
    "support.support-request.resolved": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        resolution: { resolutionType: string; resolvedAt: string };
      };
      await port.resolveHold(
        {
          supportRequestId: data.supportRequestId,
          resolutionType: data.resolution.resolutionType,
          occurredAt: data.resolution.resolvedAt,
        },
        eventContext(event),
      );
    },
    "support.support-request.closed": async (event) => {
      const data = event.data as { supportRequestId: string; closedAt: string };
      await port.closeHold(
        { supportRequestId: data.supportRequestId, occurredAt: data.closedAt },
        eventContext(event),
      );
    },
    "support.support-request.cancelled": async (event) => {
      const data = event.data as { supportRequestId: string; cancelledAt: string };
      await port.cancelHold(
        { supportRequestId: data.supportRequestId, occurredAt: data.cancelledAt },
        eventContext(event),
      );
    },
  };
}
