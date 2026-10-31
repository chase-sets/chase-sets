import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import type { CohortEvaluation, CohortState, DisclosureBand } from "../domain/cohort-window";

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

function timestampToIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function normalize(row: StoredCohort & Record<string, unknown>): StoredCohort {
  return {
    ...row,
    entryEffectiveAt: timestampToIso(row.entryEffectiveAt as Date | string | null),
    exitEffectiveAt: timestampToIso(row.exitEffectiveAt as Date | string | null),
    windowStart: timestampToIso(row.windowStart as Date | string | null),
    windowEnd: timestampToIso(row.windowEnd as Date | string | null),
    nextReevaluationAt: timestampToIso(row.nextReevaluationAt as Date | string | null),
  };
}
export async function readSellerComplianceCohort(
  db: PgQueryable,
  sellerAccountId: string,
): Promise<StoredCohort | null> {
  const result = await db.query<StoredCohort>(
    `SELECT seller_account_id AS "sellerAccountId", state, disclosure_band AS band, version::text, policy_version AS "policyVersion", entry_effective_at AS "entryEffectiveAt", exit_effective_at AS "exitEffectiveAt", window_start AS "windowStart", window_end AS "windowEnd", qualifying_count AS "qualifyingCount", qualifying_gross_cents::text AS "qualifyingGrossCents", unclassifiable_count AS "unclassifiableCount", next_reevaluation_at AS "nextReevaluationAt" FROM platform_operations_seller_compliance_cohorts WHERE seller_account_id = $1`,
    [sellerAccountId],
  );
  return result.rows[0] ? normalize(result.rows[0] as StoredCohort & Record<string, unknown>) : null;
}

/** The seller's latest recorded transition, plus the latest entry and exit, from the immutable ledger. */
export type CohortLedgerHead = Readonly<{
  version: string;
  state: CohortState;
  band: DisclosureBand;
  policyVersion: string;
  effectiveAt: string;
  observedAt: string;
  entryEffectiveAt: string | null;
  exitEffectiveAt: string | null;
}>;

export async function readSellerComplianceCohortLedgerHead(
  db: PgQueryable,
  sellerAccountId: string,
): Promise<CohortLedgerHead | null> {
  // The text alias differs from the column name, so ORDER BY compares the bigint column, never its text.
  const result = await db.query<{
    kind: string;
    version: string;
    effective_at: Date | string;
    observed_at: Date | string;
    policy_version: string;
    target_state: CohortState;
    target_band: DisclosureBand;
  }>(
    `SELECT DISTINCT ON (kind) kind, transition_version::text AS version, effective_at, observed_at, policy_version, target_state, target_band FROM platform_operations_seller_compliance_cohort_transitions WHERE seller_account_id = $1 ORDER BY kind, transition_version DESC`,
    [sellerAccountId],
  );
  if (result.rows.length === 0) return null;
  const latest = result.rows.reduce((head, row) => (BigInt(row.version) > BigInt(head.version) ? row : head));
  const latestOf = (kind: string) => {
    const row = result.rows.find((candidate) => candidate.kind === kind);
    return row ? timestampToIso(row.effective_at) : null;
  };
  return {
    version: latest.version,
    state: latest.target_state,
    band: latest.target_band,
    policyVersion: latest.policy_version,
    effectiveAt: timestampToIso(latest.effective_at)!,
    observedAt: timestampToIso(latest.observed_at)!,
    entryEffectiveAt: latest.target_state === "member" ? latestOf("entered") : null,
    exitEffectiveAt: latest.target_state === "outside" ? latestOf("exited") : null,
  };
}

/**
 * Writes one evaluation atomically with its transitions. `expectedVersion` is the cohort version the evaluation was
 * based on; a missing row's version is the retained ledger's latest transition, so a cohort-only restore continues
 * that seller's transition ids instead of restarting them. Nothing is written when the base has moved, or when the
 * evidence is unchanged: a newer policy version alone never rewrites the row.
 */
export async function writeSellerComplianceCohort(
  pool: PgTransactionalPool,
  input: Readonly<{
    sellerAccountId: string;
    policyVersion: string;
    observedAt: string;
    evaluation: CohortEvaluation;
    expectedVersion: string;
  }>,
): Promise<void> {
  await withPgTransaction(pool, async (db) => {
    const current = await db.query<StoredCohort>(
      `SELECT seller_account_id AS "sellerAccountId", state, disclosure_band AS band, version::text, policy_version AS "policyVersion", entry_effective_at AS "entryEffectiveAt", exit_effective_at AS "exitEffectiveAt", window_start AS "windowStart", window_end AS "windowEnd", qualifying_count AS "qualifyingCount", qualifying_gross_cents::text AS "qualifyingGrossCents", unclassifiable_count AS "unclassifiableCount", next_reevaluation_at AS "nextReevaluationAt" FROM platform_operations_seller_compliance_cohorts WHERE seller_account_id = $1 FOR UPDATE`,
      [input.sellerAccountId],
    );
    const old = current.rows[0] ? normalize(current.rows[0] as StoredCohort & Record<string, unknown>) : undefined;
    const ledger = old
      ? undefined
      : (
          await db.query<{ version: string; target_state: string; target_band: string }>(
            `SELECT transition_version::text AS version, target_state, target_band FROM platform_operations_seller_compliance_cohort_transitions WHERE seller_account_id = $1 ORDER BY transition_version DESC LIMIT 1`,
            [input.sellerAccountId],
          )
        ).rows[0];
    const prior =
      old ??
      (ledger
        ? { state: ledger.target_state, band: ledger.target_band, version: ledger.version }
        : { state: "outside", band: "none", version: "0" });
    if (prior.version !== input.expectedVersion) return;
    const derivedChanged =
      !old ||
      old.state !== input.evaluation.state ||
      old.band !== input.evaluation.band ||
      old.entryEffectiveAt !== input.evaluation.entryEffectiveAt ||
      old.exitEffectiveAt !== input.evaluation.exitEffectiveAt ||
      old.windowStart !== input.evaluation.windowStart ||
      old.windowEnd !== input.evaluation.windowEnd ||
      old.qualifyingCount !== input.evaluation.qualifyingCount ||
      old.qualifyingGrossCents !== input.evaluation.qualifyingGrossCents ||
      old.unclassifiableCount !== input.evaluation.unclassifiableCount ||
      old.nextReevaluationAt !== input.evaluation.nextReevaluationAt;
    if (!derivedChanged) return;
    const kinds: readonly string[] =
      prior.state !== input.evaluation.state
        ? input.evaluation.state === "member"
          ? ["entered", ...(input.evaluation.band === "disclosure" ? ["disclosure-band-changed"] : [])]
          : ["exited"]
        : prior.band !== input.evaluation.band
          ? ["disclosure-band-changed"]
          : [];
    // A transition is dated by its own cause; the observation instant is never a stand-in for it.
    const effectiveAts = kinds.map((kind) => {
      const effectiveAt =
        kind === "exited"
          ? input.evaluation.exitEffectiveAt
          : kind === "disclosure-band-changed"
            ? input.evaluation.bandEffectiveAt
            : input.evaluation.entryEffectiveAt;
      if (effectiveAt === null)
        throw new Error(`A ${kind} transition for ${input.sellerAccountId} requires an effective instant.`);
      return effectiveAt;
    });
    const version = BigInt(prior.version) + BigInt(kinds.length);
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
      const transitionVersion = BigInt(prior.version) + BigInt(index + 1);
      await db.query(
        `INSERT INTO platform_operations_seller_compliance_cohort_transitions (transition_id,seller_account_id,transition_version,kind,effective_at,observed_at,policy_version,target_state,target_band) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (transition_id) DO NOTHING`,
        [
          `${input.sellerAccountId}:${transitionVersion.toString()}:${kind}`,
          input.sellerAccountId,
          transitionVersion.toString(),
          kind,
          effectiveAts[index],
          input.observedAt,
          input.policyVersion,
          input.evaluation.state,
          kind === "exited" || kind === "entered" ? "none" : input.evaluation.band,
        ],
      );
    }
  });
}
