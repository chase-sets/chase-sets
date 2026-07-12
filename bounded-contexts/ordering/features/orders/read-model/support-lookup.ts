import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Support-safe order lookup for the unified support-reference router. Both
 * entry points are single indexed lookups: `display_reference` carries
 * the unique index added alongside the order display-reference projection
 * (see `display-reference.ts`), and `order_id` is the table's primary key.
 */
export type OrderingSupportLookupRow = Readonly<{
  order_id: string;
  display_reference: string;
  status: string;
  source_type: string;
  buyer_account_id: string;
  seller_account_id: string;
  total_amount: string;
  created_at: string;
}>;

const supportLookupSelect = `
  SELECT
    order_id,
    display_reference,
    status,
    source_type,
    buyer_account_id,
    seller_account_id,
    total_amount::text AS total_amount,
    created_at
  FROM ordering_order_pages
`;

export async function lookupOrderBySupportReference(
  db: PgQueryable,
  displayReference: string,
): Promise<OrderingSupportLookupRow | null> {
  const result = await db.query<OrderingSupportLookupRow>(`${supportLookupSelect} WHERE display_reference = $1`, [
    displayReference,
  ]);

  return result.rows[0] ?? null;
}

export async function lookupOrderBySupportId(
  db: PgQueryable,
  orderId: string,
): Promise<OrderingSupportLookupRow | null> {
  const result = await db.query<OrderingSupportLookupRow>(`${supportLookupSelect} WHERE order_id = $1`, [orderId]);

  return result.rows[0] ?? null;
}
