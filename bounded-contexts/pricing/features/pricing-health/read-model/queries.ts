import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { RepricingHealthSummary } from "../../repricing-engine/api/health-summary";

export type PricingHealthRun = Readonly<{
  dryRunId: string;
  requestedAt: string;
  completedAt: string;
  bodyHash: string;
}>;

export async function readPricingHealthRun(
  db: PgQueryable,
  input: Readonly<{ accountId: string; policyId: string; bodyHash: string }>,
) {
  const values = [input.accountId, input.policyId, input.bodyHash];
  const completed = await db.query<PricingHealthRun & { health: RepricingHealthSummary | null }>(
    `SELECT dry_run_id AS "dryRunId", requested_at::text AS "requestedAt",
       completed_at::text AS "completedAt", body_hash AS "bodyHash", health
     FROM pricing_repricing_dry_runs
     WHERE seller_account_id = $1 AND replacing_policy_id = $2 AND body_hash = $3
       AND status = 'completed' AND health IS NOT NULL
     ORDER BY completed_at DESC, dry_run_id DESC LIMIT 1`,
    values,
  );
  const pending = await db.query<{ computing: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pricing_repricing_dry_runs AS run
       JOIN pricing_repricing_dry_run_jobs AS job ON job.job_id = run.dry_run_id
         AND job.payload->>'sellerAccountId' = run.seller_account_id
       WHERE run.seller_account_id = $1 AND run.replacing_policy_id = $2 AND run.body_hash = $3
         AND run.status IN ('queued', 'running') AND job.status <> 'failed') AS computing`,
    values,
  );
  const row = completed.rows[0];
  return {
    health: row?.health ?? null,
    run: row
      ? { dryRunId: row.dryRunId, requestedAt: row.requestedAt, completedAt: row.completedAt, bodyHash: row.bodyHash }
      : null,
    computing: pending.rows[0]?.computing ?? false,
  };
}
