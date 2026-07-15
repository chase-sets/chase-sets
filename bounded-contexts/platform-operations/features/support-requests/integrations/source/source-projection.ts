import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
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
    "fulfillment.shipment.created": async (event) => {
      const data = event.data as {
        shipmentId: string;
        orderId: string;
        buyerAccountId: string;
        sellerAccountId: string;
        createdAt: string;
      };

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
      const data = event.data as {
        shipmentId: string;
        dispatchedAt: string;
      };

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
      const data = event.data as {
        shipmentId: string;
        trackingIdentifier: string | null;
        deliveredAt: string;
      };

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
  };
}
