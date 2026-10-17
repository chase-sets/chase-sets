import type { ChaseSetsEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { SupportRequestServices } from "../../api/runtime";

export function buildSupportOrderSourceProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "ordering.order.created": async (event) => {
      const data = event.data as {
        orderId: string;
        buyerAccountId: string;
        shippingDestinationSnapshot?: { email?: string | null } | null;
        sellerAccountId: string;
        totalAmount: string;
        lines?: Array<{
          lineId?: string;
          listingId?: string;
          itemTitle?: string;
          productSummary?: string | null;
          quantity?: number;
          gradedCard?: {
            gradingCompany?: string;
            grade?: string;
            certificationNumber?: string | null;
          } | null;
        }>;
      };
      const returnContext = (data.lines ?? []).map((line) => ({
        lineId: String(line.lineId ?? ""),
        listingId: String(line.listingId ?? ""),
        itemTitle: String(line.itemTitle ?? "Item"),
        productSummary: line.productSummary ?? null,
        quantity: Math.max(1, Math.trunc(Number(line.quantity ?? 1))),
        gradedCard: line.gradedCard
          ? {
              gradingCompany: String(line.gradedCard.gradingCompany ?? ""),
              grade: String(line.gradedCard.grade ?? ""),
              certificationNumber: line.gradedCard.certificationNumber ?? null,
            }
          : null,
      }));

      await db.query(
        `INSERT INTO support_order_sources (
           order_id,
           buyer_account_id,
           buyer_email,
           seller_account_id,
           status,
           total_amount,
           return_context,
           created_at,
           updated_at,
           cancelled_at,
           ready_for_fulfillment_at
         ) VALUES ($1, $2, $3, $4, 'created', $5, $6::jsonb, now(), now(), NULL, NULL)
         ON CONFLICT (order_id) DO UPDATE
         SET buyer_account_id = EXCLUDED.buyer_account_id,
             buyer_email = EXCLUDED.buyer_email,
             seller_account_id = EXCLUDED.seller_account_id,
             total_amount = EXCLUDED.total_amount,
             return_context = EXCLUDED.return_context,
             updated_at = now()`,
        [
          data.orderId,
          data.buyerAccountId,
          data.shippingDestinationSnapshot?.email?.trim() || null,
          data.sellerAccountId,
          data.totalAmount,
          JSON.stringify(returnContext),
        ],
      );
    },
    "ordering.order.cancelled": async (event) => {
      const data = event.data as {
        orderId: string;
        cancelledAt: string;
      };

      await db.query(
        `UPDATE support_order_sources
         SET status = 'cancelled',
             cancelled_at = $2,
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.cancelledAt],
      );
    },
    "ordering.order.ready-for-fulfillment-recorded": async (event) => {
      const data = event.data as {
        orderId: string;
        readyForFulfillmentAt: string;
      };

      await db.query(
        `UPDATE support_order_sources
         SET status = 'ready-for-fulfillment',
             ready_for_fulfillment_at = $2,
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.readyForFulfillmentAt],
      );
    },
  };
}

export function buildSupportShipmentSourceProjectionHandlers(
  db: PgQueryable,
  remedyEffects?: Pick<SupportRequestServices, "recordRemedyEffect">,
): ProjectorHandlerMap {
  return {
    ...defineProjectorHandlers<
      Pick<
        ChaseSetsEventPayloads,
        "fulfillment.shipment.created" | "fulfillment.shipment.dispatched" | "fulfillment.shipment.delivered"
      >
    >({
      "fulfillment.shipment.created": async (event) => {
        const { data } = event;

        await db.query(
          `INSERT INTO support_shipment_sources (
           shipment_id,
           order_id,
           buyer_account_id,
           seller_account_id,
           status,
           tracking_identifier,
           created_at,
           updated_at,
           dispatched_at,
           delivered_at,
           returned_at,
           exception_type,
           exception_notes
         ) VALUES ($1, $2, $3, $4, 'created', NULL, $5, $5, NULL, NULL, NULL, NULL, NULL)
         ON CONFLICT (shipment_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             buyer_account_id = EXCLUDED.buyer_account_id,
             seller_account_id = EXCLUDED.seller_account_id,
             updated_at = EXCLUDED.updated_at`,
          [data.shipmentId, data.orderId, data.buyerAccountId, data.sellerAccountId, data.createdAt],
        );
      },
      "fulfillment.shipment.dispatched": async (event) => {
        const { data } = event;

        await db.query(
          `UPDATE support_shipment_sources
         SET status = 'dispatched',
             dispatched_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
          [data.shipmentId, data.dispatchedAt],
        );
      },
      "fulfillment.shipment.delivered": async (event) => {
        const { data } = event;

        await db.query(
          `UPDATE support_shipment_sources
         SET status = 'delivered',
             tracking_identifier = COALESCE($2, tracking_identifier),
             delivered_at = $3,
             updated_at = $3
         WHERE shipment_id = $1`,
          [data.shipmentId, data.trackingIdentifier, data.deliveredAt],
        );
      },
    }),
    "fulfillment.shipment.returned": async (event) => {
      const data = event.data as {
        shipmentId: string;
        reason: string | null;
        returnedAt: string;
      };

      await db.query(
        `UPDATE support_shipment_sources
         SET status = 'returned',
             returned_at = $2,
             exception_notes = COALESCE($3, exception_notes),
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.returnedAt, data.reason],
      );
    },
    "fulfillment.shipment.exception-raised": async (event) => {
      const data = event.data as {
        shipmentId: string;
        exceptionType: string;
        notes: string | null;
        raisedAt: string;
      };

      await db.query(
        `UPDATE support_shipment_sources
         SET status = 'exception',
             exception_type = $2,
             exception_notes = $3,
             updated_at = $4
         WHERE shipment_id = $1`,
        [data.shipmentId, data.exceptionType, data.notes, data.raisedAt],
      );
    },
    "fulfillment.return-shipment.facility-intake-completed.v1": async (event) => {
      if (!remedyEffects) {
        return;
      }
      const data = event.data as {
        remedyId: string;
        supportRequestId: string;
        intake: { receivedAt: string; idempotencyKey: string };
      };
      const context: EventStoreContext = {
        tenantId: event.tenantId,
        audit: event.audit,
        trace: event.trace,
      };
      await remedyEffects.recordRemedyEffect(
        {
          supportRequestId: data.supportRequestId,
          remedyId: data.remedyId as never,
          coverageId: null,
          effect: "facility-intake",
          outcome: "satisfied",
          sourceFactType: event.type,
          sourceFactId: event.id,
          idempotencyKey: data.intake.idempotencyKey,
          occurredAt: data.intake.receivedAt,
          reasonCode: "facility-intake-completed",
          refundId: null,
          amount: null,
          currencyCode: null,
          allocation: null,
        },
        context,
      );
    },
    "fulfillment.return-shipment.carrier-accepted.v1": async (event) => {
      const data = event.data as {
        remedyId: string;
        supportRequestId: string;
        metadata: { idempotencyKey: string };
        occurredAt: string;
      };
      await correlateReturnMilestoneToRefundTrigger(db, remedyEffects, {
        event,
        remedyId: data.remedyId,
        supportRequestId: data.supportRequestId,
        milestoneTrigger: "carrier-accepted",
        effect: "carrier-accepted",
        idempotencyKey: data.metadata.idempotencyKey,
        occurredAt: data.occurredAt,
        reasonCode: "return-carrier-accepted",
      });
    },
    "fulfillment.return-shipment.delivered.v1": async (event) => {
      const data = event.data as {
        remedyId: string;
        supportRequestId: string;
        metadata: { idempotencyKey: string };
        deliveredAt: string;
      };
      await correlateReturnMilestoneToRefundTrigger(db, remedyEffects, {
        event,
        remedyId: data.remedyId,
        supportRequestId: data.supportRequestId,
        milestoneTrigger: "delivered",
        effect: "return-delivered",
        idempotencyKey: data.metadata.idempotencyKey,
        occurredAt: data.deliveredAt,
        reasonCode: "return-delivered",
      });
    },
  };
}

/**
 * Correlates a reverse-shipment carrier milestone to the remedy's authorized refund
 * trigger. Fulfillment reports the logistics fact; Support decides whether it
 * financially authorizes a release. The milestone is recorded as a remedy effect
 * only when the remedy's authorized `refundTrigger` matches this milestone — a
 * delivered scan never satisfies a facility-intake trigger, and a carrier-accepted
 * scan never satisfies a delivered trigger. Recording is idempotent on the
 * milestone's stable idempotency key, and the Support aggregate releases the refund
 * at most once, so duplicate or replayed carrier facts converge without a second
 * release. When the milestone is not the authorized trigger it is a no-op here; the
 * logistics fact still lives in Fulfillment's own tracking projection.
 */
async function correlateReturnMilestoneToRefundTrigger(
  db: PgQueryable,
  remedyEffects: Pick<SupportRequestServices, "recordRemedyEffect"> | undefined,
  params: Readonly<{
    event: {
      type: string;
      id: string;
      tenantId: EventStoreContext["tenantId"];
      audit: EventStoreContext["audit"];
      trace: EventStoreContext["trace"];
    };
    remedyId: string;
    supportRequestId: string;
    milestoneTrigger: string;
    effect: "carrier-accepted" | "return-delivered";
    idempotencyKey: string;
    occurredAt: string;
    reasonCode: string;
  }>,
): Promise<void> {
  if (!remedyEffects) {
    return;
  }
  const authorized = await db.query<{ refund_trigger: string | null }>(
    `SELECT remedy->>'refundTrigger' AS refund_trigger
     FROM support_request_pages
     WHERE support_request_id = $1
       AND remedy->>'remedyId' = $2`,
    [params.supportRequestId, params.remedyId],
  );
  const refundTrigger = authorized.rows[0]?.refund_trigger ?? null;
  if (refundTrigger !== params.milestoneTrigger) {
    return;
  }
  const context: EventStoreContext = {
    tenantId: params.event.tenantId,
    audit: params.event.audit,
    trace: params.event.trace,
  };
  await remedyEffects.recordRemedyEffect(
    {
      supportRequestId: params.supportRequestId,
      remedyId: params.remedyId as never,
      coverageId: null,
      effect: params.effect,
      outcome: "satisfied",
      sourceFactType: params.event.type,
      sourceFactId: params.event.id,
      idempotencyKey: params.idempotencyKey,
      occurredAt: params.occurredAt,
      reasonCode: params.reasonCode,
      refundId: null,
      amount: null,
      currencyCode: null,
      allocation: null,
    },
    context,
  );
}
