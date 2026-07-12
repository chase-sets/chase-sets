import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Support-safe shipment lookup for the unified support-reference router.
 * Both entry points are single indexed lookups: `display_reference`
 * carries the unique index added alongside the shipment display-reference
 * projection (see `display-reference.ts`), and `shipment_id` is the table's
 * primary key.
 */
export type FulfillmentSupportLookupRow = Readonly<{
  shipment_id: string;
  display_reference: string;
  status: string;
  order_id: string;
  seller_account_id: string;
  tracking_identifier: string | null;
  created_at: string;
}>;

const supportLookupSelect = `
  SELECT
    shipment_id,
    display_reference,
    status,
    order_id,
    seller_account_id,
    tracking_identifier,
    created_at
  FROM fulfillment_shipment_pages
`;

export async function lookupShipmentBySupportReference(
  db: PgQueryable,
  displayReference: string,
): Promise<FulfillmentSupportLookupRow | null> {
  const result = await db.query<FulfillmentSupportLookupRow>(`${supportLookupSelect} WHERE display_reference = $1`, [
    displayReference,
  ]);

  return result.rows[0] ?? null;
}

export async function lookupShipmentBySupportId(
  db: PgQueryable,
  shipmentId: string,
): Promise<FulfillmentSupportLookupRow | null> {
  const result = await db.query<FulfillmentSupportLookupRow>(`${supportLookupSelect} WHERE shipment_id = $1`, [
    shipmentId,
  ]);

  return result.rows[0] ?? null;
}
