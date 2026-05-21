import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CheckoutSessionLine, CheckoutShippingAddress } from "../domain/domain";

export type CheckoutSessionRow = Readonly<{
  session_id: string;
  buyer_account_id: string;
  source_type: "cart" | "buy-now" | "offer-intent";
  optimization_goal: "lowest-total" | "fewest-shipments";
  fulfillment_preview_revision: string | null;
  shipping_option: "standard" | "expedited" | "priority";
  shipping_address_id: string | null;
  shipping_address: CheckoutShippingAddress | null;
  lines: readonly CheckoutSessionLine[];
  order_ids: readonly string[];
  payment_id: string | null;
  submitted_offer_id: string | null;
  created_at: string;
  updated_at: string;
}>;

type CheckoutSessionPageRow = Omit<
  CheckoutSessionRow,
  "lines" | "order_ids" | "source_type" | "shipping_option" | "optimization_goal"
> &
  Readonly<{
    source_type: string;
    optimization_goal: string;
    shipping_option: string;
    shipping_address: unknown;
    lines: unknown;
    order_ids: unknown;
  }>;

function mapSessionRow(row: CheckoutSessionPageRow): CheckoutSessionRow {
  return {
    ...row,
    source_type:
      row.source_type === "buy-now" ? "buy-now" : row.source_type === "offer-intent" ? "offer-intent" : "cart",
    optimization_goal: row.optimization_goal === "fewest-shipments" ? "fewest-shipments" : "lowest-total",
    shipping_option:
      row.shipping_option === "expedited" || row.shipping_option === "priority" ? row.shipping_option : "standard",
    shipping_address:
      typeof row.shipping_address === "object" && row.shipping_address !== null
        ? (row.shipping_address as CheckoutShippingAddress)
        : null,
    lines: Array.isArray(row.lines) ? (row.lines as CheckoutSessionLine[]) : [],
    order_ids: Array.isArray(row.order_ids)
      ? row.order_ids.filter((value): value is string => typeof value === "string")
      : [],
  };
}

export async function getCheckoutSession(
  db: PgQueryable,
  sessionId: string,
  buyerAccountId: string,
): Promise<CheckoutSessionRow | null> {
  const result = await db.query<CheckoutSessionPageRow>(
    `SELECT
       session_id,
       buyer_account_id,
       source_type,
       optimization_goal,
       fulfillment_preview_revision,
       shipping_option,
       shipping_address_id,
       shipping_address,
       lines,
       order_ids,
       payment_id,
       submitted_offer_id,
       created_at,
       updated_at
     FROM checkout_session_pages
     WHERE session_id = $1
       AND buyer_account_id = $2`,
    [sessionId, buyerAccountId],
  );

  const row = result.rows[0];
  return row ? mapSessionRow(row) : null;
}
