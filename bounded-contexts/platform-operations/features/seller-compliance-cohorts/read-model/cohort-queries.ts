import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type CohortSweepCheckpoint = Readonly<{
  version: string;
  lastCompletedSnapshot: string;
  currentSnapshot: string | null;
  rawPageCursor: string | null;
  sellerCursor: string | null;
  policyHorizon: string;
  currentPolicyHorizon: string | null;
  evaluationAt: string | null;
  lastEvaluationAt: string | null;
}>;

export async function readCohortSweepCheckpoint(db: PgQueryable): Promise<CohortSweepCheckpoint> {
  await db.query(
    `INSERT INTO platform_operations_seller_compliance_sweep_checkpoints (trigger) VALUES ('cohort') ON CONFLICT (trigger) DO NOTHING`,
  );
  const result = await db.query<
    Omit<CohortSweepCheckpoint, "evaluationAt" | "lastEvaluationAt"> & {
      evaluationAt: Date | string | null;
      lastEvaluationAt: Date | string | null;
    }
  >(
    `SELECT version::text, last_completed_snapshot::text AS "lastCompletedSnapshot", current_snapshot::text AS "currentSnapshot",
      raw_page_cursor AS "rawPageCursor", seller_cursor AS "sellerCursor", policy_horizon::text AS "policyHorizon",
      current_policy_horizon::text AS "currentPolicyHorizon", evaluation_at AS "evaluationAt", last_evaluation_at AS "lastEvaluationAt"
     FROM platform_operations_seller_compliance_sweep_checkpoints WHERE trigger = 'cohort' FOR UPDATE`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("Seller compliance sweep checkpoint is unavailable.");
  return {
    ...row,
    evaluationAt: row.evaluationAt instanceof Date ? row.evaluationAt.toISOString() : row.evaluationAt,
    lastEvaluationAt: row.lastEvaluationAt instanceof Date ? row.lastEvaluationAt.toISOString() : row.lastEvaluationAt,
  };
}

export async function writeCohortSweepCheckpoint(
  db: PgQueryable,
  old: CohortSweepCheckpoint,
  next: CohortSweepCheckpoint,
): Promise<CohortSweepCheckpoint> {
  const result = await db.query(
    `UPDATE platform_operations_seller_compliance_sweep_checkpoints
     SET version = version + 1, last_completed_snapshot = $2, current_snapshot = $3,
       raw_page_cursor = $4, seller_cursor = $5, policy_horizon = $6,
       current_policy_horizon = $7, evaluation_at = $8, last_evaluation_at = $9
     WHERE trigger = 'cohort' AND version = $1`,
    [
      old.version,
      next.lastCompletedSnapshot,
      next.currentSnapshot,
      next.rawPageCursor,
      next.sellerCursor,
      next.policyHorizon,
      next.currentPolicyHorizon,
      next.evaluationAt,
      next.lastEvaluationAt,
    ],
  );
  if (result.rowCount !== 1) throw new Error("Seller compliance sweep checkpoint lost its read version.");
  return { ...next, version: (BigInt(old.version) + 1n).toString() };
}

export async function listCohortChangedSellers(
  db: PgQueryable,
  input: Readonly<{
    lastCompletedSnapshot: string;
    currentSnapshot: string;
    afterSellerAccountId: string | null;
    evaluationAt: string;
    policyChanged: boolean;
    limit: number;
  }>,
): Promise<readonly string[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new Error("Cohort seller page limit must be between 1 and 100.");
  if (
    !/^\d+$/.test(input.lastCompletedSnapshot) ||
    !/^\d+$/.test(input.currentSnapshot) ||
    BigInt(input.lastCompletedSnapshot) > BigInt(input.currentSnapshot)
  )
    throw new Error("Cohort seller snapshot range is invalid.");
  const result = await db.query<{ seller_account_id: string }>(
    `SELECT seller_account_id FROM (
       SELECT seller_account_id FROM platform_operations_seller_compliance_sales
       WHERE recorded_at IS NOT NULL AND seller_account_id IS NOT NULL
         AND change_sequence <= $2::bigint AND ($5::boolean OR change_sequence > $1::bigint)
       UNION
       SELECT seller_account_id FROM platform_operations_seller_compliance_cohorts
       WHERE $5::boolean OR next_reevaluation_at <= $4::timestamptz
     ) candidates
     WHERE ($3::text IS NULL OR seller_account_id > $3::text)
     ORDER BY seller_account_id ASC LIMIT $6`,
    [
      input.lastCompletedSnapshot,
      input.currentSnapshot,
      input.afterSellerAccountId,
      input.evaluationAt,
      input.policyChanged,
      input.limit,
    ],
  );
  return result.rows.map((row) => row.seller_account_id);
}

export type CohortEvaluationFailure = Readonly<{
  sellerAccountId: string;
  evaluationAt: string;
  failureKind: string;
  policyVersion: string | null;
  detail: string;
}>;

export async function recordCohortEvaluationFailure(db: PgQueryable, failure: CohortEvaluationFailure): Promise<void> {
  await db.query(
    `INSERT INTO platform_operations_seller_compliance_evaluation_failures
       (seller_account_id, evaluation_at, failure_kind, policy_version, detail)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (seller_account_id, evaluation_at, failure_kind) DO NOTHING`,
    [failure.sellerAccountId, failure.evaluationAt, failure.failureKind, failure.policyVersion, failure.detail],
  );
}
