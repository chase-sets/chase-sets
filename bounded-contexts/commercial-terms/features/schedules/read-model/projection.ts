import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type ScheduleHistoryPayload = Readonly<{
  label: string;
  accountType?: string;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  shippingAllowancePercentageBps: number;
  status: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
}>;

async function insertScheduleHistory(
  db: PgQueryable,
  params: Readonly<{
    scheduleId: string;
    eventId: string;
    eventType: string;
    actorUserId: string;
    status: string;
    payload: ScheduleHistoryPayload;
    effectiveFrom: string;
    effectiveUntil: string | null;
    recordedAt: string;
  }>,
) {
  await db.query(
    `INSERT INTO commercial_terms_schedule_history (
       schedule_id,
       event_id,
       event_type,
       actor_user_id,
       status,
       payload,
       effective_from,
       effective_until,
       recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9
     )
     ON CONFLICT (event_id) DO UPDATE
     SET schedule_id = EXCLUDED.schedule_id,
         event_type = EXCLUDED.event_type,
         actor_user_id = EXCLUDED.actor_user_id,
         status = EXCLUDED.status,
         payload = EXCLUDED.payload,
         effective_from = EXCLUDED.effective_from,
         effective_until = EXCLUDED.effective_until,
         recorded_at = EXCLUDED.recorded_at`,
    [
      params.scheduleId,
      params.eventId,
      params.eventType,
      params.actorUserId,
      params.status,
      JSON.stringify(params.payload),
      params.effectiveFrom,
      params.effectiveUntil,
      params.recordedAt,
    ],
  );
}

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
        createdByUserId?: string;
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
      await insertScheduleHistory(db, {
        scheduleId: data.scheduleId,
        eventId: event.id,
        eventType: "created",
        actorUserId: data.createdByUserId ?? event.audit.performedByUserId,
        status: data.status,
        payload: {
          label: data.label,
          accountType: data.accountType,
          marketplaceSalesFeePercentageBps: data.marketplaceSalesFeePercentageBps,
          marketplaceSalesFeeFixedAmount: data.marketplaceSalesFeeFixedAmount,
          shippingAllowancePercentageBps: data.shippingAllowancePercentageBps ?? 500,
          status: data.status,
          effectiveFrom: data.effectiveFrom,
          effectiveUntil: data.effectiveUntil,
        },
        effectiveFrom: data.effectiveFrom,
        effectiveUntil: data.effectiveUntil,
        recordedAt: event.timing.recordedAt,
      });
    },
    "commercial-terms.schedule.revised": async (event) => {
      const data = event.data as {
        scheduleId: string;
        label: string;
        marketplaceSalesFeePercentageBps: number;
        marketplaceSalesFeeFixedAmount: string;
        shippingAllowancePercentageBps: number;
        status: string;
        effectiveFrom: string;
        effectiveUntil: string | null;
        revisedByUserId?: string;
      };

      await db.query(
        `UPDATE commercial_terms_schedule_pages
         SET label = $2,
             marketplace_sales_fee_percentage_bps = $3,
             marketplace_sales_fee_fixed_amount = $4,
             shipping_allowance_percentage_bps = $5,
             status = $6,
             effective_from = $7,
             effective_until = $8,
             updated_at = $9
         WHERE schedule_id = $1`,
        [
          data.scheduleId,
          data.label,
          data.marketplaceSalesFeePercentageBps,
          data.marketplaceSalesFeeFixedAmount,
          data.shippingAllowancePercentageBps,
          data.status,
          data.effectiveFrom,
          data.effectiveUntil,
          event.timing.recordedAt,
        ],
      );
      await insertScheduleHistory(db, {
        scheduleId: data.scheduleId,
        eventId: event.id,
        eventType: "revised",
        actorUserId: data.revisedByUserId ?? event.audit.performedByUserId,
        status: data.status,
        payload: {
          label: data.label,
          marketplaceSalesFeePercentageBps: data.marketplaceSalesFeePercentageBps,
          marketplaceSalesFeeFixedAmount: data.marketplaceSalesFeeFixedAmount,
          shippingAllowancePercentageBps: data.shippingAllowancePercentageBps,
          status: data.status,
          effectiveFrom: data.effectiveFrom,
          effectiveUntil: data.effectiveUntil,
        },
        effectiveFrom: data.effectiveFrom,
        effectiveUntil: data.effectiveUntil,
        recordedAt: event.timing.recordedAt,
      });
    },
  };
}
