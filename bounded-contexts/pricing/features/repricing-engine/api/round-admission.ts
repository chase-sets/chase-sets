import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";

export type PricingRoundClaim = Readonly<{
  roundId: string;
  executorId: string;
  claimOwnerId: string;
  attemptCount: number;
  catalogItemId: string;
  productId: string;
}>;

/** Admission has no expiry. A job lease only fences executors of the SAME retained round. */
export function createPricingRoundAdmission(pool: PgTransactionalPool) {
  async function assertClaim(db: PgQueryable, claim: PricingRoundClaim) {
    const result = await db.query(
      `SELECT job_id FROM pricing_repricing_evaluation_jobs
       WHERE job_id = $1 AND claim_owner_id = $2 AND attempt_count = $3
         AND status = 'running' AND claimed_until > clock_timestamp() FOR UPDATE`,
      [claim.roundId, claim.claimOwnerId, claim.attemptCount],
    );
    if (!result.rows.length) throw new Error("Pricing round executor claim lost.");
  }
  async function local<T>(claim: PricingRoundClaim, run: (db: PgQueryable) => Promise<T>) {
    return withPgTransaction(pool, async (db) => {
      await assertClaim(db, claim);
      const row = await db.query<{ status: string }>(
        `SELECT status FROM pricing_repricing_round_admissions WHERE round_id = $1
           AND catalog_catalog_item_id = $2 AND product_id = $3 AND executor_id = $4 FOR UPDATE`,
        [claim.roundId, claim.catalogItemId, claim.productId, claim.executorId],
      );
      if (row.rows[0]?.status !== "active") throw new Error("Pricing round admission is not active.");
      return run(db);
    });
  }
  return {
    async admit(claim: PricingRoundClaim): Promise<boolean> {
      return withPgTransaction(pool, async (db) => {
        await assertClaim(db, claim);
        await db.query(
          `INSERT INTO pricing_repricing_round_admissions
             (round_id, catalog_catalog_item_id, product_id, status, executor_id)
           VALUES ($1, $2, $3, 'active', $4) ON CONFLICT DO NOTHING`,
          [claim.roundId, claim.catalogItemId, claim.productId, claim.executorId],
        );
        const row = await db.query<{ status: string }>(
          `SELECT status FROM pricing_repricing_round_admissions WHERE round_id = $1
             AND catalog_catalog_item_id = $2 AND product_id = $3`,
          [claim.roundId, claim.catalogItemId, claim.productId],
        );
        if (row.rows[0] && row.rows[0].status !== "active") throw new Error("Pricing round is already closed.");
        if (row.rows.length)
          await db.query("UPDATE pricing_repricing_round_admissions SET executor_id = $2 WHERE round_id = $1", [
            claim.roundId,
            claim.executorId,
          ]);
        else
          // Waiting for another Product round is not an execution failure or a dead-letter attempt.
          await db.query(
            "UPDATE pricing_repricing_evaluation_jobs SET attempt_count = GREATEST(0, attempt_count - 1) WHERE job_id = $1",
            [claim.roundId],
          );
        return row.rows.length === 1;
      });
    },
    async read<T>(claim: PricingRoundClaim, key: string): Promise<T | undefined> {
      return local(claim, async (db) => {
        const row = await db.query<{ checkpoints: Record<string, T> }>(
          "SELECT checkpoints FROM pricing_repricing_round_admissions WHERE round_id = $1",
          [claim.roundId],
        );
        return row.rows[0]!.checkpoints[key];
      });
    },
    /** Only local SQL belongs in this callback. Its effect and first result commit together. */
    async once<T>(claim: PricingRoundClaim, key: string, run: (db: PgQueryable) => Promise<T>): Promise<T> {
      return local(claim, async (db) => {
        const row = await db.query<{ checkpoints: Record<string, T> }>(
          "SELECT checkpoints FROM pricing_repricing_round_admissions WHERE round_id = $1",
          [claim.roundId],
        );
        if (Object.hasOwn(row.rows[0]!.checkpoints, key)) return row.rows[0]!.checkpoints[key]!;
        const result = await run(db);
        await db.query(
          "UPDATE pricing_repricing_round_admissions SET checkpoints = checkpoints || $2::jsonb WHERE round_id = $1",
          [claim.roundId, JSON.stringify({ [key]: result })],
        );
        return result;
      });
    },
    async closeCompleted(roundId: string) {
      await pool.query(
        `UPDATE pricing_repricing_round_admissions admission SET status = 'completed', closed_at = now()
         WHERE round_id = $1 AND status = 'active' AND EXISTS (
           SELECT 1 FROM pricing_repricing_evaluation_jobs job WHERE job.job_id = admission.round_id
             AND job.status = 'completed')`,
        [roundId],
      );
    },
    async recoverCompleted() {
      const result = await pool.query(
        `WITH terminal AS (
           SELECT admission.round_id FROM pricing_repricing_round_admissions admission
           JOIN pricing_repricing_evaluation_jobs job ON job.job_id = admission.round_id
           WHERE admission.status = 'active' AND job.status = 'completed' ORDER BY admission.round_id LIMIT 100
         ) UPDATE pricing_repricing_round_admissions admission SET status = 'completed', closed_at = now()
           FROM terminal WHERE admission.round_id = terminal.round_id RETURNING admission.round_id`,
      );
      return result.rows.length;
    },
  };
}
