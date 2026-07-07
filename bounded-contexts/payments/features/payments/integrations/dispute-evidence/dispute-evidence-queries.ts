import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { OrderId } from "@chase-sets/primitives/typed-ids";

export type PaymentsFulfillmentDisputeEvidenceSourceRow = Readonly<{
  shipment_id: string;
  order_id: string;
  buyer_account_id: string;
  seller_account_id: string;
  status: string;
  shipping_method: string | null;
  carrier_name: string | null;
  tracking_identifier: string | null;
  shipping_destination_snapshot: AddressSnapshot | null;
  lines: readonly Readonly<{
    itemTitle?: string | null;
    itemSubtitle?: string | null;
    productSummary?: string | null;
    quantity?: number | null;
  }>[];
  label_attached_at: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  updated_at: string;
}>;

export async function listFulfillmentDisputeEvidenceSources(
  db: PgQueryable,
  orderIds: readonly OrderId[],
): Promise<readonly PaymentsFulfillmentDisputeEvidenceSourceRow[]> {
  if (orderIds.length === 0) {
    return [];
  }

  const result = await db.query<PaymentsFulfillmentDisputeEvidenceSourceRow>(
    `SELECT
       shipment_id,
       order_id,
       buyer_account_id,
       seller_account_id,
       status,
       shipping_method,
       carrier_name,
       tracking_identifier,
       shipping_destination_snapshot,
       lines,
       label_attached_at::text AS label_attached_at,
       dispatched_at::text AS dispatched_at,
       delivered_at::text AS delivered_at,
       updated_at::text AS updated_at
     FROM payments_fulfillment_dispute_evidence_sources
     WHERE order_id = ANY($1)
     ORDER BY delivered_at DESC NULLS LAST, dispatched_at DESC NULLS LAST, label_attached_at DESC NULLS LAST`,
    [orderIds],
  );

  return result.rows;
}
