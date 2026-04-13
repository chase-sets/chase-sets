import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId, OrderId } from "@chase-sets/primitives/typed-ids";

export type PaymentOrderInputRow = Readonly<{
  order_id: string;
  buyer_account_id: string;
  total_amount: string;
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
       status
     FROM payments_order_inputs
     WHERE buyer_account_id = $1
       AND order_id = ANY($2)`,
    [buyerAccountId, orderIds],
  );

  return result.rows;
}
