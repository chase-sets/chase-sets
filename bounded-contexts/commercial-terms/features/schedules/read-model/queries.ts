import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { findOverlappingActivePolicyDocument } from "@chase-sets/platform-policy/queries";
import { commercialTermsSchedulePolicyKey } from "../../../support/runtime-support/terms-policy";
import type { CommercialAccountType } from "../../../support/runtime-support/common";

/**
 * Schedules read against the shared `platform_policy_documents` /
 * `platform_policy_document_history` tables (see
 * `infrastructure/platform-policy/schema.ts`) instead of the bespoke,
 * now-dropped per-schedule read-model table that preceded the platform-policy
 * convergence (retirement migration: `unlogged-projection-migrations.ts`).
 * Row shapes below are unchanged from the pre-convergence bespoke projection
 * so the admin API/UI contract stays identical; the targeting field
 * (`account_type`) and fee terms are extracted out of the opaque `value`
 * jsonb column set by `terms-policy.ts`'s schedule policy value shape.
 */

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
  accountType: CommercialAccountType;
  effectiveFrom: string;
  effectiveUntil: string | null;
  excludeScheduleId?: string | null;
}>;

const scheduleSelect = `
  SELECT
    document_id AS schedule_id,
    value->>'label' AS label,
    value->>'accountType' AS account_type,
    (value->>'marketplaceSalesFeePercentageBps')::integer AS marketplace_sales_fee_percentage_bps,
    value->>'marketplaceSalesFeeFixedAmount' AS marketplace_sales_fee_fixed_amount,
    (value->>'shippingAllowancePercentageBps')::integer AS shipping_allowance_percentage_bps,
    status,
    effective_from,
    effective_until,
    created_at,
    updated_at
  FROM platform_policy_documents
`;

export async function listSchedules(db: PgQueryable, params: Readonly<{ limit?: number; offset?: number }> = {}) {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);
  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM platform_policy_documents WHERE policy_key LIKE 'commercial-terms.schedule.%'`,
    ),
    db.query<CommercialTermsScheduleRow>(
      `${scheduleSelect}
       WHERE policy_key LIKE 'commercial-terms.schedule.%'
       ORDER BY value->>'accountType' ASC, effective_from DESC, updated_at DESC
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
     WHERE document_id = $1
       AND policy_key LIKE 'commercial-terms.schedule.%'`,
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
       document_id AS schedule_id,
       event_type,
       actor_user_id,
       status,
       value AS payload,
       effective_from,
       effective_until,
       recorded_at
     FROM platform_policy_document_history
     WHERE document_id = $1
     ORDER BY recorded_at DESC, history_id DESC`,
    [scheduleId],
  );

  return result.rows;
}

export async function findOverlappingActiveSchedule(db: PgQueryable, params: ScheduleWindowCheck) {
  const overlap = await findOverlappingActivePolicyDocument(db, {
    policyKey: commercialTermsSchedulePolicyKey(params.accountType),
    effectiveFrom: params.effectiveFrom,
    effectiveUntil: params.effectiveUntil,
    excludeDocumentId: params.excludeScheduleId,
  });

  return overlap ? { schedule_id: overlap.document_id } : null;
}
