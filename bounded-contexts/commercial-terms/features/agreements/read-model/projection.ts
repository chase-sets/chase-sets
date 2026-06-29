import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type AgreementHistoryPayload = Readonly<{
  accountId?: string;
  label: string;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  shippingAllowancePercentageBps: number;
  status: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
}>;

async function insertAgreementHistory(
  db: PgQueryable,
  params: Readonly<{
    agreementId: string;
    eventId: string;
    eventType: string;
    actorUserId: string;
    status: string;
    payload: AgreementHistoryPayload;
    effectiveFrom: string;
    effectiveUntil: string | null;
    recordedAt: string;
  }>,
) {
  await db.query(
    `INSERT INTO commercial_terms_agreement_history (
       agreement_id,
       event_id,
       event_type,
       actor_user_id,
       status,
       payload,
       effective_from,
       effective_until,
       recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9
     )
     ON CONFLICT (event_id) DO UPDATE
     SET agreement_id = EXCLUDED.agreement_id,
         event_type = EXCLUDED.event_type,
         actor_user_id = EXCLUDED.actor_user_id,
         status = EXCLUDED.status,
         payload = EXCLUDED.payload,
         effective_from = EXCLUDED.effective_from,
         effective_until = EXCLUDED.effective_until,
         recorded_at = EXCLUDED.recorded_at`,
    [
      params.agreementId,
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

export function buildAgreementProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "commercial-terms.agreement.created": async (event) => {
      const data = event.data as {
        agreementId: string;
        accountId: string;
        label: string;
        marketplaceSalesFeePercentageBps: number;
        marketplaceSalesFeeFixedAmount: string;
        shippingAllowancePercentageBps?: number;
        status: string;
        effectiveFrom: string;
        effectiveUntil: string | null;
        createdByUserId?: string;
      };

      await db.query(
        `INSERT INTO commercial_terms_agreement_pages (
           agreement_id,
           account_id,
           label,
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
         ON CONFLICT (agreement_id) DO UPDATE
         SET account_id = EXCLUDED.account_id,
             label = EXCLUDED.label,
             marketplace_sales_fee_percentage_bps = EXCLUDED.marketplace_sales_fee_percentage_bps,
             marketplace_sales_fee_fixed_amount = EXCLUDED.marketplace_sales_fee_fixed_amount,
             shipping_allowance_percentage_bps = EXCLUDED.shipping_allowance_percentage_bps,
             status = EXCLUDED.status,
             effective_from = EXCLUDED.effective_from,
             effective_until = EXCLUDED.effective_until,
             updated_at = EXCLUDED.updated_at`,
        [
          data.agreementId,
          data.accountId,
          data.label,
          data.marketplaceSalesFeePercentageBps,
          data.marketplaceSalesFeeFixedAmount,
          data.shippingAllowancePercentageBps ?? 500,
          data.status,
          data.effectiveFrom,
          data.effectiveUntil,
          event.timing.recordedAt,
        ],
      );
      await insertAgreementHistory(db, {
        agreementId: data.agreementId,
        eventId: event.id,
        eventType: "created",
        actorUserId: data.createdByUserId ?? event.audit.performedByUserId,
        status: data.status,
        payload: {
          accountId: data.accountId,
          label: data.label,
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
    "commercial-terms.agreement.revised": async (event) => {
      const data = event.data as {
        agreementId: string;
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
        `UPDATE commercial_terms_agreement_pages
         SET label = $2,
             marketplace_sales_fee_percentage_bps = $3,
             marketplace_sales_fee_fixed_amount = $4,
             shipping_allowance_percentage_bps = $5,
             status = $6,
             effective_from = $7,
             effective_until = $8,
             updated_at = $9
         WHERE agreement_id = $1`,
        [
          data.agreementId,
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
      await insertAgreementHistory(db, {
        agreementId: data.agreementId,
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
