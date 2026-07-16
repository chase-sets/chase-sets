import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";

/** Reason recorded on an order cancellation that a support resolution drove. */
export const SUPPORT_CANCEL_ORDER_REASON = "support-cancel-order";

export type OrderingSupportCancellationDispatch = (
  input: Readonly<{
    streamId: string;
    command: Readonly<{ type: "CancelOrder"; cancelledAt: string; reason: string }>;
    context: EventStoreContext;
  }>,
) => Promise<unknown>;

/**
 * Reacts to a support resolution that cancels an order by dispatching CancelOrder
 * so the order actually transitions to cancelled. Cancellation is what releases
 * the inventory holds (inventory reacts to `ordering.order.cancelled`) and drives
 * the cancellation refund; without it a `cancel-order` resolution would leave the
 * order fulfillable while money was refunded. Only `cancel-order` resolutions
 * cancel; every other resolution is ignored here. The dispatch is idempotent —
 * the order aggregate no-ops an already-cancelled order — so redelivery is safe.
 */
export function buildOrderingSupportCancellationReactionHandlers(
  dispatch: OrderingSupportCancellationDispatch,
): ProjectorHandlerMap {
  return {
    "support.support-request.resolved": async (event) => {
      const data = event.data as Readonly<{
        orderId: string;
        resolution: Readonly<{ resolutionType: string; resolvedAt: string }>;
      }>;
      if (data.resolution.resolutionType !== "cancel-order") {
        return;
      }

      await dispatch({
        streamId: `ordering.order-${data.orderId}`,
        command: {
          type: "CancelOrder",
          cancelledAt: data.resolution.resolvedAt,
          reason: SUPPORT_CANCEL_ORDER_REASON,
        },
        context: {
          tenantId: event.tenantId,
          audit: event.audit,
          trace: event.trace,
        },
      });
    },
  };
}
