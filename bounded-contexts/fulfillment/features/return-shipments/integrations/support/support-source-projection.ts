import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { returnLabelRemedyIdForSupportRequest } from "../../domain/support-return-label-policy";

type SupportReturnReaction = Readonly<{
  onResolved?: (
    input: Readonly<{
      supportRequestId: string;
      flowType: string;
      resolution: Readonly<{ resolutionType: string; resolvedAt: string }>;
    }>,
    context: EventStoreContext,
  ) => Promise<unknown>;
  onCancelled?: (
    input: Readonly<{ supportRequestId: string; reason: string }>,
    context: EventStoreContext,
  ) => Promise<unknown>;
}>;

function eventContext(event: {
  tenantId: EventStoreContext["tenantId"];
  audit: EventStoreContext["audit"];
  trace: EventStoreContext["trace"];
}): EventStoreContext {
  return { tenantId: event.tenantId, audit: event.audit, trace: event.trace };
}

export function buildFulfillmentSupportReturnSourceProjectionHandlers(
  db: PgQueryable,
  reaction: SupportReturnReaction = {},
): ProjectorHandlerMap {
  return {
    "support.support-request.opened": async (event) => {
      const data = event.data as { supportRequestId: string; orderId: string; openedAt: string };
      await db.query(
        `INSERT INTO fulfillment_support_return_sources (
           support_request_id, order_id, affected_order_line_ids, updated_at
         ) VALUES ($1, $2, '[]'::jsonb, $3)
         ON CONFLICT (support_request_id) DO UPDATE SET
           order_id = EXCLUDED.order_id,
           updated_at = EXCLUDED.updated_at`,
        [data.supportRequestId, data.orderId, data.openedAt],
      );
    },
    "support.support-request.affected-line-items-recorded": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        affectedLineItems: readonly { lineId: string }[];
      };
      const affectedOrderLineIds = data.affectedLineItems.map((line) => line.lineId.trim());
      await db.query(
        `UPDATE fulfillment_support_return_sources
         SET affected_order_line_ids = $2::jsonb,
             updated_at = $3
         WHERE support_request_id = $1`,
        [data.supportRequestId, JSON.stringify(affectedOrderLineIds), event.timing.recordedAt],
      );
    },
    "support.support-request.remedy-authorized.v1": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        remedyId: string;
        returnDirective: string;
        occurredAt: string;
      };
      await db.query(
        `INSERT INTO fulfillment_support_return_remedy_sources (
           remedy_id, support_request_id, return_directive, updated_at
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (remedy_id) DO UPDATE SET
           support_request_id = EXCLUDED.support_request_id,
           return_directive = EXCLUDED.return_directive,
           updated_at = EXCLUDED.updated_at`,
        [data.remedyId, data.supportRequestId, data.returnDirective, data.occurredAt],
      );
    },
    "support.support-request.resolved": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        flowType: string;
        resolution: { resolutionType: string; resolvedAt: string };
      };
      if (data.resolution.resolutionType !== "return-for-refund") return;
      await db.query(
        `INSERT INTO fulfillment_support_return_remedy_sources (
           remedy_id, support_request_id, return_directive, updated_at
         ) VALUES ($1, $2, 'return-to-seller', $3)
         ON CONFLICT (remedy_id) DO UPDATE SET
           support_request_id = EXCLUDED.support_request_id,
           return_directive = EXCLUDED.return_directive,
           updated_at = EXCLUDED.updated_at`,
        [
          returnLabelRemedyIdForSupportRequest(data.supportRequestId),
          data.supportRequestId,
          data.resolution.resolvedAt,
        ],
      );
      await reaction.onResolved?.(data, eventContext(event));
    },
    "support.support-request.cancelled": async (event) => {
      const data = event.data as { supportRequestId: string; cancellationReason?: string };
      await reaction.onCancelled?.(
        { supportRequestId: data.supportRequestId, reason: data.cancellationReason ?? "support-request-cancelled" },
        eventContext(event),
      );
    },
  };
}
