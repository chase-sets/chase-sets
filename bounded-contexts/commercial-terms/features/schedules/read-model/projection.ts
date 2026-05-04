import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildScheduleProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "commercial-terms.schedule.created": async (event) => {
      const data = event.data as {
        scheduleId: string;
        label: string;
        accountType: string;
        marketplaceSalesFeePercentageBps: number;
        marketplaceSalesFeeFixedAmount: string;
        shippingAllowancePercentageBps?: number;
        status: string;
        effectiveFrom: string;
        effectiveUntil: string | null;
      };

      await db.query(
        `INSERT INTO commercial_terms_schedule_pages (
           schedule_id,
           label,
           account_type,
           marketplace_sales_fee_percentage_bps,
           marketplace_sales_fee_fixed_amount,
           shipping_allowance_percentage_bps,
           status,
           effective_from,
           effective_until,
           created_at,
           updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10
         )
         ON CONFLICT (schedule_id) DO UPDATE
         SET label = EXCLUDED.label,
             account_type = EXCLUDED.account_type,
             marketplace_sales_fee_percentage_bps = EXCLUDED.marketplace_sales_fee_percentage_bps,
             marketplace_sales_fee_fixed_amount = EXCLUDED.marketplace_sales_fee_fixed_amount,
             shipping_allowance_percentage_bps = EXCLUDED.shipping_allowance_percentage_bps,
             status = EXCLUDED.status,
             effective_from = EXCLUDED.effective_from,
             effective_until = EXCLUDED.effective_until,
             updated_at = EXCLUDED.updated_at`,
        [
          data.scheduleId,
          data.label,
          data.accountType,
          data.marketplaceSalesFeePercentageBps,
          data.marketplaceSalesFeeFixedAmount,
          data.shippingAllowancePercentageBps ?? 500,
          data.status,
          data.effectiveFrom,
          data.effectiveUntil,
          event.timing.recordedAt,
        ],
      );
    },
  };
}
