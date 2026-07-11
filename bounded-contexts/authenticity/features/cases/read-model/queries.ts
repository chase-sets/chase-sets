import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  AuthenticityChecklistResult,
  AuthenticityOrderLineNote,
  AuthenticityOrderSnapshotRef,
  AuthenticityPlanRef,
  AuthenticityVerdict,
  AuthenticityVerdictReasonCode,
} from "../../../support/runtime-support/common";

export type AuthenticityCaseRow = Readonly<{
  case_id: string;
  order_id: string;
  seller_account_id: string;
  buyer_account_id: string;
  order_snapshot: AuthenticityOrderSnapshotRef;
  authenticity_plan: AuthenticityPlanRef;
  status: string;
  inbound_tracking_identifier: string | null;
  verdict: AuthenticityVerdict | null;
  verdict_reason_codes: readonly AuthenticityVerdictReasonCode[];
  checklist_results: readonly AuthenticityChecklistResult[];
  evidence_photo_refs: readonly string[];
  line_notes: readonly AuthenticityOrderLineNote[];
  inspector_account_id: string | null;
  outbound_tracking_identifier: string | null;
  return_reason: string | null;
  opened_at: string;
  received_at: string | null;
  inspection_started_at: string | null;
  verdict_recorded_at: string | null;
  forwarded_at: string | null;
  returned_at: string | null;
  created_at: string;
  updated_at: string;
}>;

const caseColumns = `
  case_id,
  order_id,
  seller_account_id,
  buyer_account_id,
  order_snapshot,
  authenticity_plan,
  status,
  inbound_tracking_identifier,
  verdict,
  verdict_reason_codes,
  checklist_results,
  evidence_photo_refs,
  line_notes,
  inspector_account_id,
  outbound_tracking_identifier,
  return_reason,
  opened_at,
  received_at,
  inspection_started_at,
  verdict_recorded_at,
  forwarded_at,
  returned_at,
  created_at,
  updated_at
`;

export async function getAuthenticityCase(db: PgQueryable, caseId: string) {
  const result = await db.query<AuthenticityCaseRow>(
    `SELECT ${caseColumns} FROM authenticity_cases WHERE case_id = $1`,
    [caseId],
  );

  return result.rows[0] ?? null;
}

/** Per-order case status, used by buyer/seller order surfaces (AC5). */
export async function getAuthenticityCaseByOrderId(db: PgQueryable, orderId: string) {
  const result = await db.query<AuthenticityCaseRow>(
    `SELECT ${caseColumns} FROM authenticity_cases WHERE order_id = $1`,
    [orderId],
  );

  return result.rows[0] ?? null;
}

export type AuthenticityOperatorQueueFilter = Readonly<{
  status?: string | null;
  limit?: number;
  offset?: number;
}>;

/** Case pages for the operator queue: state, order, expected tracking, and age. */
export async function listAuthenticityOperatorQueue(db: PgQueryable, filter: AuthenticityOperatorQueueFilter = {}) {
  const limit = Math.max(1, Math.min(200, Math.trunc(filter.limit ?? 50)));
  const offset = Math.max(0, Math.trunc(filter.offset ?? 0));

  if (filter.status) {
    const result = await db.query<AuthenticityCaseRow>(
      `SELECT ${caseColumns} FROM authenticity_cases
       WHERE status = $1
       ORDER BY opened_at ASC
       LIMIT $2 OFFSET $3`,
      [filter.status, limit, offset],
    );
    return result.rows;
  }

  const result = await db.query<AuthenticityCaseRow>(
    `SELECT ${caseColumns} FROM authenticity_cases
     WHERE status NOT IN ('forwarded', 'returned')
     ORDER BY opened_at ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows;
}
