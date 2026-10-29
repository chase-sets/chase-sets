import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import type { CohortEvaluation } from "../domain/cohort-window";

export type StoredCohort = Readonly<{
  sellerAccountId: string;
  state: string;
  band: string;
  version: string;
  policyVersion: string;
  entryEffectiveAt: string | null;
  exitEffectiveAt: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  qualifyingCount: number;
  qualifyingGrossCents: string;
  unclassifiableCount: number;
  nextReevaluationAt: string | null;
}>;
export async function readSellerComplianceCohort(
  db: PgQueryable,
  sellerAccountId: string,
): Promise<StoredCohort | null> {
  const result = await db.query<StoredCohort>(
    `SELECT seller_account_id AS "sellerAccountId", state, disclosure_band AS band, version::text, policy_version AS "policyVersion", entry_effective_at AS "entryEffectiveAt", exit_effective_at AS "exitEffectiveAt", window_start AS "windowStart", window_end AS "windowEnd", qualifying_count AS "qualifyingCount", qualifying_gross_cents::text AS "qualifyingGrossCents", unclassifiable_count AS "unclassifiableCount", next_reevaluation_at AS "nextReevaluationAt" FROM platform_operations_seller_compliance_cohorts WHERE seller_account_id = $1`,
    [sellerAccountId],
  );
  return result.rows[0] ?? null;
}

export async function writeSellerComplianceCohort(
  pool: PgTransactionalPool,
  input: Readonly<{ sellerAccountId: string; policyVersion: string; observedAt: string; evaluation: CohortEvaluation }>,
): Promise<void> {
  await withPgTransaction(pool, async (db) => {
    const current = await db.query<StoredCohort>(
      `SELECT seller_account_id AS "sellerAccountId", state, disclosure_band AS band, version::text, policy_version AS "policyVersion", entry_effective_at AS "entryEffectiveAt", exit_effective_at AS "exitEffectiveAt", window_start AS "windowStart", window_end AS "windowEnd", qualifying_count AS "qualifyingCount", qualifying_gross_cents::text AS "qualifyingGrossCents", unclassifiable_count AS "unclassifiableCount", next_reevaluation_at AS "nextReevaluationAt" FROM platform_operations_seller_compliance_cohorts WHERE seller_account_id = $1 FOR UPDATE`,
      [input.sellerAccountId],
    );
    const old = current.rows[0];
    const derivedChanged =
      !old ||
      old.state !== input.evaluation.state ||
      old.band !== input.evaluation.band ||
      old.policyVersion !== input.policyVersion ||
      old.entryEffectiveAt !== input.evaluation.entryEffectiveAt ||
      old.exitEffectiveAt !== input.evaluation.exitEffectiveAt ||
      old.windowStart !== input.evaluation.windowStart ||
      old.windowEnd !== input.evaluation.windowEnd ||
      old.qualifyingCount !== input.evaluation.qualifyingCount ||
      old.qualifyingGrossCents !== input.evaluation.qualifyingGrossCents ||
      old.unclassifiableCount !== input.evaluation.unclassifiableCount ||
      old.nextReevaluationAt !== input.evaluation.nextReevaluationAt;
    if (!derivedChanged) return;
    const membershipChanged = !old || old.state !== input.evaluation.state || old.band !== input.evaluation.band;
    const kinds: readonly string[] = !membershipChanged
      ? []
      : old === undefined
        ? [
            input.evaluation.state === "member" ? "entered" : "exited",
            ...(input.evaluation.state === "member" && input.evaluation.band === "disclosure"
              ? ["disclosure-band-changed"]
              : []),
          ]
        : old.state !== input.evaluation.state
          ? [input.evaluation.state === "member" ? "entered" : "exited"]
          : ["disclosure-band-changed"];
    const version = BigInt(old?.version ?? "0") + BigInt(kinds.length);
    const values = [
      input.sellerAccountId,
      input.evaluation.state,
      input.evaluation.band,
      input.evaluation.entryEffectiveAt,
      input.evaluation.exitEffectiveAt,
      input.evaluation.windowStart,
      input.evaluation.windowEnd,
      input.evaluation.qualifyingCount,
      input.evaluation.qualifyingGrossCents,
      input.evaluation.unclassifiableCount,
      input.policyVersion,
      version.toString(),
      input.evaluation.nextReevaluationAt,
      input.observedAt,
    ];
    const result =
      old === undefined
        ? await db.query(
            `INSERT INTO platform_operations_seller_compliance_cohorts (seller_account_id,state,disclosure_band,entry_effective_at,exit_effective_at,window_start,window_end,qualifying_count,qualifying_gross_cents,unclassifiable_count,policy_version,version,next_reevaluation_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (seller_account_id) DO NOTHING`,
            values,
          )
        : await db.query(
            `UPDATE platform_operations_seller_compliance_cohorts SET state=$2, disclosure_band=$3, entry_effective_at=$4, exit_effective_at=$5, window_start=$6, window_end=$7, qualifying_count=$8, qualifying_gross_cents=$9, unclassifiable_count=$10, policy_version=$11, version=$12, next_reevaluation_at=$13, updated_at=$14 WHERE seller_account_id=$1 AND version=$15`,
            [...values, old.version],
          );
    if (result.rowCount !== 1) return;
    for (const [index, kind] of kinds.entries()) {
      const transitionVersion = BigInt(old?.version ?? "0") + BigInt(index + 1);
      const effectiveAt =
        kind === "exited"
          ? input.evaluation.exitEffectiveAt
          : kind === "disclosure-band-changed"
            ? input.evaluation.bandEffectiveAt
            : input.evaluation.entryEffectiveAt;
      await db.query(
        `INSERT INTO platform_operations_seller_compliance_cohort_transitions (transition_id,seller_account_id,transition_version,kind,effective_at,observed_at,policy_version,target_state,target_band) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (transition_id) DO NOTHING`,
        [
          `${input.sellerAccountId}:${transitionVersion.toString()}:${kind}`,
          input.sellerAccountId,
          transitionVersion.toString(),
          kind,
          effectiveAt ?? input.observedAt,
          input.observedAt,
          input.policyVersion,
          input.evaluation.state,
          kind === "exited" ? "none" : input.evaluation.band,
        ],
      );
    }
  });
}
