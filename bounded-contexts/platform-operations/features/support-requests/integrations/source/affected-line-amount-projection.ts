import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type SupportAffectedLineAmountSourceContext = "ordering" | "payments";

export function buildSupportAffectedLineAmountProjectionHandlers(
  db: PgQueryable,
  sourceContextName?: SupportAffectedLineAmountSourceContext,
): ProjectorHandlerMap {
  const handlers: Record<string, ProjectorHandlerMap[string]> = {};

  if (!sourceContextName || sourceContextName === "ordering") {
    handlers["ordering.order.line-item-amounts-published"] = async (event) => {
      const data = event.data as {
        orderId: string;
        lineItems: readonly { lineId: string; amount: string }[];
      };

      await db.query(`DELETE FROM support_order_affected_line_amounts WHERE order_id = $1`, [data.orderId]);
      for (const lineItem of data.lineItems) {
        await db.query(
          `INSERT INTO support_order_affected_line_amounts (
             order_id,
             line_id,
             amount,
             currency_code,
             updated_at
           )
           SELECT $1, $2, $3, currency_code, now()
           FROM support_order_payment_currencies
           WHERE order_id = $1
           ON CONFLICT (order_id, line_id) DO UPDATE
           SET amount = EXCLUDED.amount,
               currency_code = EXCLUDED.currency_code,
               updated_at = EXCLUDED.updated_at`,
          [data.orderId, lineItem.lineId, lineItem.amount],
        );

        await db.query(
          `INSERT INTO support_order_affected_line_amounts (
             order_id,
             line_id,
             amount,
             currency_code,
             updated_at
           )
           SELECT $1, $2, $3, NULL, now()
           WHERE NOT EXISTS (
             SELECT 1
             FROM support_order_affected_line_amounts
             WHERE order_id = $1 AND line_id = $2
           )`,
          [data.orderId, lineItem.lineId, lineItem.amount],
        );
      }
    };
  }

  if (!sourceContextName || sourceContextName === "payments") {
    handlers["payments.payment-created"] = async (event) => {
      const data = event.data as {
        orderIds: readonly string[];
        currencyCode: string;
      };
      const currencyCode = data.currencyCode.trim().toLowerCase();

      for (const orderId of data.orderIds) {
        await db.query(
          `INSERT INTO support_order_payment_currencies (order_id, currency_code, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (order_id) DO UPDATE
           SET currency_code = EXCLUDED.currency_code,
               updated_at = EXCLUDED.updated_at`,
          [orderId, currencyCode],
        );
        await db.query(
          `UPDATE support_order_affected_line_amounts
           SET currency_code = $2,
               updated_at = now()
           WHERE order_id = $1`,
          [orderId, currencyCode],
        );
      }
    };
  }

  return handlers;
}
