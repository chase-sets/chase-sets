import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type CommercialTermsScheduleRow = Readonly<{
  schedule_id: string;
  label: string;
  account_type: string;
  marketplace_sales_fee_percentage_bps: number;
  marketplace_sales_fee_fixed_amount: string;
  shipping_allowance_percentage_bps: number;
  status: string;
  effective_from: string;
  effective_until: string | null;
  created_at: string;
  updated_at: string;
  history?: readonly CommercialTermsScheduleHistoryRow[];
}>;

export type CommercialTermsScheduleHistoryRow = Readonly<{
  history_id: string;
  event_id: string;
  schedule_id: string;
  event_type: string;
  actor_user_id: string;
  status: string;
  payload: Record<string, unknown>;
  effective_from: string;
  effective_until: string | null;
  recorded_at: string;
}>;

export type ScheduleWindowCheck = Readonly<{
  accountType: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  excludeScheduleId?: string | null;
}>;

const scheduleSelect = `
  SELECT
    schedule_id,
    label,
    account_type,
    marketplace_sales_fee_percentage_bps,
    marketplace_sales_fee_fixed_amount::text,
    shipping_allowance_percentage_bps,
    status,
    effective_from,
    effective_until,
    created_at,
    updated_at
  FROM commercial_terms_schedule_pages
`;

export async function listSchedules(db: PgQueryable, params: Readonly<{ limit?: number; offset?: number }> = {}) {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);
  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>("SELECT COUNT(*) AS count FROM commercial_terms_schedule_pages"),
    db.query<CommercialTermsScheduleRow>(
      `${scheduleSelect}
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
    `${scheduleSelect}
     WHERE schedule_id = $1`,
    [scheduleId],
  );
  const schedule = result.rows[0];
  if (!schedule) {
    return null;
  }

  return {
    ...schedule,
    history: await listScheduleHistory(db, scheduleId),
  };
}

export async function listScheduleHistory(db: PgQueryable, scheduleId: string) {
  const result = await db.query<CommercialTermsScheduleHistoryRow>(
    `SELECT
       history_id::text AS history_id,
       event_id,
       schedule_id,
       event_type,
       actor_user_id,
       status,
       payload,
       effective_from,
       effective_until,
       recorded_at
     FROM commercial_terms_schedule_history
     WHERE schedule_id = $1
     ORDER BY recorded_at DESC, history_id DESC`,
    [scheduleId],
  );

  return result.rows;
}

export async function findOverlappingActiveSchedule(db: PgQueryable, params: ScheduleWindowCheck) {
  const result = await db.query<{ schedule_id: string }>(
    `SELECT schedule_id
     FROM commercial_terms_schedule_pages
     WHERE account_type = $1
       AND status = 'active'
       AND ($4::text IS NULL OR schedule_id <> $4)
       AND tstzrange(effective_from, COALESCE(effective_until, 'infinity'::timestamptz), '[)')
         && tstzrange($2::timestamptz, COALESCE($3::timestamptz, 'infinity'::timestamptz), '[)')
     LIMIT 1`,
    [params.accountType, params.effectiveFrom, params.effectiveUntil, params.excludeScheduleId ?? null],
  );

  return result.rows[0] ?? null;
}
