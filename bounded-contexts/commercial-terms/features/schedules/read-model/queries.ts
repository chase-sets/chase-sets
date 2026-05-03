import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type CommercialTermsScheduleRow = Readonly<{
  schedule_id: string;
  label: string;
  account_type: string;
  marketplace_sales_fee_percentage_bps: number;
  marketplace_sales_fee_fixed_amount: string;
  status: string;
  effective_from: string;
  effective_until: string | null;
  created_at: string;
  updated_at: string;
}>;

export async function listSchedules(
  db: PgQueryable,
  params: Readonly<{ limit?: number; offset?: number }> = {},
) {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);
  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>("SELECT COUNT(*) AS count FROM commercial_terms_schedule_pages"),
    db.query<CommercialTermsScheduleRow>(
      `SELECT
         schedule_id,
         label,
         account_type,
         marketplace_sales_fee_percentage_bps,
         marketplace_sales_fee_fixed_amount::text,
         status,
         effective_from,
         effective_until,
         created_at,
         updated_at
       FROM commercial_terms_schedule_pages
       ORDER BY account_type ASC, effective_from DESC, updated_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getSchedule(db: PgQueryable, scheduleId: string) {
  const result = await db.query<CommercialTermsScheduleRow>(
    `SELECT
       schedule_id,
       label,
       account_type,
       marketplace_sales_fee_percentage_bps,
       marketplace_sales_fee_fixed_amount::text,
       status,
       effective_from,
       effective_until,
       created_at,
       updated_at
     FROM commercial_terms_schedule_pages
     WHERE schedule_id = $1`,
    [scheduleId],
  );
  return result.rows[0] ?? null;
}
