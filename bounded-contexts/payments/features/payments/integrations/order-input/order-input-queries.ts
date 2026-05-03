import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId, OrderId } from "@chase-sets/primitives/typed-ids";

export type PaymentOrderInputRow = Readonly<{
  order_id: string;
  buyer_account_id: string;
  total_amount: string;
  marketplace_sales_fee_amount: string;
  marketplace_checkout_fee_amount: string;
  seller_net_amount: string;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string;
  status: string;
}>;

export async function listPaymentOrderInputs(
  db: PgQueryable,
  orderIds: readonly OrderId[],
  buyerAccountId: AccountId,
): Promise<readonly PaymentOrderInputRow[]> {
  if (orderIds.length === 0) {
    return [];
  }

  const result = await db.query<PaymentOrderInputRow>(
    `SELECT
       order_id,
       buyer_account_id,
       total_amount::text AS total_amount,
       marketplace_sales_fee_amount::text AS marketplace_sales_fee_amount,
       marketplace_checkout_fee_amount::text AS marketplace_checkout_fee_amount,
       seller_net_amount::text AS seller_net_amount,
       terms_schedule_id,
       terms_agreement_id,
       terms_resolved_at,
       status
     FROM payments_order_inputs
     WHERE buyer_account_id = $1
       AND order_id = ANY($2)`,
    [buyerAccountId, orderIds],
  );

  return result.rows;
}
