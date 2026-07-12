import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { MarketplaceSalesFeeLineSnapshotPayload } from "@chase-sets/event-core";
import type { AccountId, OrderId } from "@chase-sets/primitives/typed-ids";

export type PaymentOrderInputRow = Readonly<{
  order_id: string;
  buyer_account_id: string;
  buyer_email: string | null;
  seller_account_id: string;
  sales_tax_amount: string;
  total_amount: string;
  marketplace_sales_fee_amount: string;
  marketplace_sales_fee_lines?: readonly MarketplaceSalesFeeLineSnapshotPayload[];
  authenticity_fee_amount: string;
  marketplace_checkout_fee_amount: string;
  seller_net_amount: string;
  seller_item_net_amount: string;
  shipping_allowance_amount: string;
  shipping_overage_amount: string;
  seller_shipping_payout_amount: string;
  seller_payout_amount: string;
  shipping_allowance_percentage_bps: number;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string;
  status: string;
  pending_payment_at: string | null;
  payment_deadline_at: string | null;
  payment_deadline_policy: string | null;
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
       buyer_email,
       seller_account_id,
       sales_tax_amount::text AS sales_tax_amount,
       total_amount::text AS total_amount,
       marketplace_sales_fee_amount::text AS marketplace_sales_fee_amount,
       marketplace_sales_fee_lines,
       authenticity_fee_amount::text AS authenticity_fee_amount,
       marketplace_checkout_fee_amount::text AS marketplace_checkout_fee_amount,
       seller_net_amount::text AS seller_net_amount,
       seller_item_net_amount::text AS seller_item_net_amount,
        shipping_allowance_amount::text AS shipping_allowance_amount,
        shipping_overage_amount::text AS shipping_overage_amount,
        seller_shipping_payout_amount::text AS seller_shipping_payout_amount,
        seller_payout_amount::text AS seller_payout_amount,
       shipping_allowance_percentage_bps,
       terms_schedule_id,
       terms_agreement_id,
       terms_resolved_at,
       status,
       pending_payment_at,
       payment_deadline_at,
       payment_deadline_policy
     FROM payments_order_inputs
     WHERE buyer_account_id = $1
       AND order_id = ANY($2)`,
    [buyerAccountId, orderIds],
  );

  return result.rows;
}
