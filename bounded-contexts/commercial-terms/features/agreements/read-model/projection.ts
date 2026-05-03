import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildAgreementProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "commercial-terms.agreement.created": async (event) => {
      const data = event.data as {
        agreementId: string;
        accountId: string;
        label: string;
        marketplaceFeePercentageBps: number;
        marketplaceFeeFixedAmount: string;
        status: string;
        effectiveFrom: string;
        effectiveUntil: string | null;
      };

      await db.query(
        `INSERT INTO commercial_terms_agreement_pages (
           agreement_id,
           account_id,
           label,
           marketplace_fee_percentage_bps,
           marketplace_fee_fixed_amount,
           status,
           effective_from,
           effective_until,
           created_at,
           updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $9
         )
         ON CONFLICT (agreement_id) DO UPDATE
         SET account_id = EXCLUDED.account_id,
             label = EXCLUDED.label,
             marketplace_fee_percentage_bps = EXCLUDED.marketplace_fee_percentage_bps,
             marketplace_fee_fixed_amount = EXCLUDED.marketplace_fee_fixed_amount,
             status = EXCLUDED.status,
             effective_from = EXCLUDED.effective_from,
             effective_until = EXCLUDED.effective_until,
             updated_at = EXCLUDED.updated_at`,
        [
          data.agreementId,
          data.accountId,
          data.label,
          data.marketplaceFeePercentageBps,
          data.marketplaceFeeFixedAmount,
          data.status,
          data.effectiveFrom,
          data.effectiveUntil,
          event.timing.recordedAt,
        ],
      );
    },
  };
}
