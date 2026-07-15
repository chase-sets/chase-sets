import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildSupportReturnLabelSourceProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  const projectRequested = async (event: Parameters<ProjectorHandlerMap[string]>[0]) => {
    const data = event.data as {
      returnShipmentId: string;
      supportRequestId: string;
      costPayer: string;
      shipByDeadlineAt: string;
      returnByDeadlineAt: string;
      requestedAt: string;
    };
    await db.query(
      `INSERT INTO support_return_label_sources (
         support_request_id, return_shipment_id, status, label_status, cost_payer,
         ship_by_deadline_at, return_by_deadline_at, updated_at
       ) VALUES ($1, $2, 'requested', 'pending', $3, $4::timestamptz, $5::timestamptz, $6::timestamptz)
       ON CONFLICT (support_request_id) DO UPDATE SET
         return_shipment_id = EXCLUDED.return_shipment_id,
         cost_payer = EXCLUDED.cost_payer,
         ship_by_deadline_at = EXCLUDED.ship_by_deadline_at,
         return_by_deadline_at = EXCLUDED.return_by_deadline_at,
         updated_at = EXCLUDED.updated_at`,
      [
        data.supportRequestId,
        data.returnShipmentId,
        data.costPayer,
        data.shipByDeadlineAt,
        data.returnByDeadlineAt,
        data.requestedAt,
      ],
    );
  };

  async function advance(returnShipmentId: string, status: string, occurredAt: string): Promise<void> {
    await db.query(
      `UPDATE support_return_label_sources SET status = $2, updated_at = $3::timestamptz
       WHERE return_shipment_id = $1`,
      [returnShipmentId, status, occurredAt],
    );
  }

  return {
    "fulfillment.return-shipment.requested.v1": projectRequested,
    "fulfillment.return-shipment.requested.v2": projectRequested,
    "fulfillment.return-shipment.label-ready.v1": async (event) => {
      const data = event.data as {
        returnShipmentId: string;
        trackingIdentifier: string;
        labelDocumentUrl: string;
        postageAmountCents: number | null;
        postageCurrency: string | null;
        readyAt: string;
      };
      await db.query(
        `UPDATE support_return_label_sources
         SET status = 'ready-to-ship', label_status = 'ready', tracking_identifier = $2,
             label_document_url = $3, postage_amount_cents = $4, postage_currency = $5,
             failure_reason = NULL, updated_at = $6::timestamptz
         WHERE return_shipment_id = $1`,
        [
          data.returnShipmentId,
          data.trackingIdentifier,
          data.labelDocumentUrl,
          data.postageAmountCents,
          data.postageCurrency,
          data.readyAt,
        ],
      );
    },
    "fulfillment.return-shipment.label-purchase-failed.v1": async (event) => {
      const data = event.data as { returnShipmentId: string; failureReason: string; failedAt: string };
      await db.query(
        `UPDATE support_return_label_sources
         SET label_status = 'failed', failure_reason = $2, updated_at = $3::timestamptz
         WHERE return_shipment_id = $1`,
        [data.returnShipmentId, data.failureReason, data.failedAt],
      );
    },
    "fulfillment.return-shipment.label-voided.v1": async (event) => {
      const data = event.data as { returnShipmentId: string; voidedAt: string };
      await db.query(
        `UPDATE support_return_label_sources
         SET label_status = 'voided', label_document_url = NULL, updated_at = $2::timestamptz
         WHERE return_shipment_id = $1`,
        [data.returnShipmentId, data.voidedAt],
      );
    },
    "fulfillment.return-shipment.carrier-accepted.v1": async (event) => {
      const data = event.data as { returnShipmentId: string; occurredAt: string };
      await advance(data.returnShipmentId, "carrier-accepted", data.occurredAt);
    },
    "fulfillment.return-shipment.in-transit-recorded.v1": async (event) => {
      const data = event.data as { returnShipmentId: string; occurredAt: string };
      await advance(data.returnShipmentId, "in-transit", data.occurredAt);
    },
    "fulfillment.return-shipment.delivered.v1": async (event) => {
      const data = event.data as { returnShipmentId: string; deliveredAt: string };
      await advance(data.returnShipmentId, "delivered", data.deliveredAt);
    },
    "fulfillment.return-shipment.cancelled.v1": async (event) => {
      const data = event.data as { returnShipmentId: string; cancelledAt: string };
      await advance(data.returnShipmentId, "cancelled", data.cancelledAt);
    },
    "fulfillment.return-shipment.expired.v1": async (event) => {
      const data = event.data as { returnShipmentId: string; expiredAt: string };
      await advance(data.returnShipmentId, "expired", data.expiredAt);
    },
  };
}
