import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import type { PolicyHistoryRecord } from "@chase-sets/platform-policy/policy-history-reader";
import type { CohortEvaluation, CohortState, DisclosureBand } from "../domain/cohort-window";
import type { SellerComplianceCohortPolicyValue } from "../domain/seller-compliance-cohort-policy";

export type StoredCohort = Readonly<{
  sellerAccountId: string;
  state: CohortState;
  band: DisclosureBand;
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
  updatedAt: string;
}>;

type TimestampKey = "entryEffectiveAt" | "exitEffectiveAt" | "windowStart" | "windowEnd" | "nextReevaluationAt";
type CohortRow = Omit<StoredCohort, TimestampKey | "updatedAt"> &
  Record<TimestampKey, Date | string | null> & { updatedAt: Date | string };

function timestampToIso(value: Date | string): string;
function timestampToIso(value: Date | string | null): string | null;
function timestampToIso(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value;
}

function normalize(row: CohortRow): StoredCohort {
  return {
    ...row,
    entryEffectiveAt: timestampToIso(row.entryEffectiveAt),
    exitEffectiveAt: timestampToIso(row.exitEffectiveAt),
    windowStart: timestampToIso(row.windowStart),
    windowEnd: timestampToIso(row.windowEnd),
    nextReevaluationAt: timestampToIso(row.nextReevaluationAt),
    updatedAt: timestampToIso(row.updatedAt),
  };
}

export async function readSellerComplianceCohort(
  db: PgQueryable,
  sellerAccountId: string,
): Promise<StoredCohort | null> {
  const result = await db.query<CohortRow>(
    `SELECT seller_account_id AS "sellerAccountId", state, disclosure_band AS band, version::text, policy_version AS "policyVersion", entry_effective_at AS "entryEffectiveAt", exit_effective_at AS "exitEffectiveAt", window_start AS "windowStart", window_end AS "windowEnd", qualifying_count AS "qualifyingCount", qualifying_gross_cents::text AS "qualifyingGrossCents", unclassifiable_count AS "unclassifiableCount", next_reevaluation_at AS "nextReevaluationAt", updated_at AS "updatedAt" FROM platform_operations_seller_compliance_cohorts WHERE seller_account_id = $1`,
    [sellerAccountId],
  );
  return result.rows[0] ? normalize(result.rows[0]) : null;
}

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
  const latestOf = (kind: string) => timestampToIso(result.rows.find((row) => row.kind === kind)?.effective_at ?? null);
  return {
    version: latest.version,
    state: latest.target_state,
    band: latest.target_band,
    policyVersion: latest.policy_version,
    effectiveAt: timestampToIso(latest.effective_at),
    observedAt: timestampToIso(latest.observed_at),
    entryEffectiveAt: latest.target_state === "member" ? latestOf("entered") : null,
    exitEffectiveAt: latest.target_state === "outside" ? latestOf("exited") : null,
  };
}

export type CohortWrite = Readonly<{
  sellerAccountId: string;
  expectedVersion: string;
  evaluation: CohortEvaluation;
  /** The caller's already-resolved policy; this store neither resolves nor records policy history. */
  policy: (Pick<PolicyHistoryRecord, "status"> & { value: SellerComplianceCohortPolicyValue }) | null;
}>;

/** A missing cohort continues from its retained ledger; retries never update a transition or its publication stamp. */
export async function writeSellerComplianceCohort(pool: PgTransactionalPool, input: CohortWrite): Promise<void> {
  const { evaluation } = input;
  if (input.policy?.status !== "active" || !input.policy.value.activated || evaluation.policyIdentity === null) return;
  const { policyKey, documentId, eventId, streamVersion } = evaluation.policyIdentity;
  const policyVersion = JSON.stringify({ policyKey, documentId, eventId, streamVersion });
  await withPgTransaction(pool, async (db) => {
    const current = await db.query<CohortRow>(
      `SELECT seller_account_id AS "sellerAccountId", state, disclosure_band AS band, version::text, policy_version AS "policyVersion", entry_effective_at AS "entryEffectiveAt", exit_effective_at AS "exitEffectiveAt", window_start AS "windowStart", window_end AS "windowEnd", qualifying_count AS "qualifyingCount", qualifying_gross_cents::text AS "qualifyingGrossCents", unclassifiable_count AS "unclassifiableCount", next_reevaluation_at AS "nextReevaluationAt", updated_at AS "updatedAt" FROM platform_operations_seller_compliance_cohorts WHERE seller_account_id = $1 FOR UPDATE`,
      [input.sellerAccountId],
    );
    const old = current.rows[0] ? normalize(current.rows[0]) : undefined;
    const ledger = await readSellerComplianceCohortLedgerHead(db, input.sellerAccountId);
    const prior = old ?? ledger ?? { state: "outside", band: "none", version: "0" };
    if (prior.version !== input.expectedVersion) return;
    if (old && old.updatedAt > evaluation.observedAt) return;
    if (ledger && ledger.observedAt > evaluation.observedAt) return;
    const derivedChanged =
      !old ||
      old.state !== evaluation.state ||
      old.band !== evaluation.band ||
      old.entryEffectiveAt !== evaluation.entryEffectiveAt ||
      old.exitEffectiveAt !== evaluation.exitEffectiveAt ||
      old.windowStart !== evaluation.windowStart ||
      old.windowEnd !== evaluation.windowEnd ||
      old.qualifyingCount !== evaluation.qualifyingCount ||
      old.qualifyingGrossCents !== evaluation.qualifyingGrossCents ||
      old.unclassifiableCount !== evaluation.unclassifiableCount ||
      old.nextReevaluationAt !== evaluation.nextReevaluationAt;
    if (!derivedChanged) return;
    const kinds =
      prior.state !== evaluation.state
        ? evaluation.state === "member"
          ? ["entered", ...(evaluation.band === "disclosure" ? ["disclosure-band-changed"] : [])]
          : ["exited"]
        : prior.band !== evaluation.band
          ? ["disclosure-band-changed"]
          : [];
    const effectiveAts = kinds.map((kind) => {
      const at =
        kind === "exited"
          ? evaluation.exitEffectiveAt
          : kind === "entered"
            ? evaluation.entryEffectiveAt
            : evaluation.bandEffectiveAt;
      if (at === null)
        throw new Error(`A ${kind} transition for ${input.sellerAccountId} requires an effective instant.`);
      if (at > evaluation.observedAt) throw new Error("A cohort transition cannot be effective after its observation.");
      return at;
    });
    if (effectiveAts.some((at, index) => index > 0 && at < effectiveAts[index - 1]!))
      throw new Error("Cohort transitions must be in causal effective-instant order.");
    if (ledger && effectiveAts.some((at) => at <= ledger.effectiveAt))
      throw new Error("A cohort transition must follow the retained ledger.");
    const version = BigInt(prior.version) + BigInt(kinds.length);
    const values = [
      input.sellerAccountId,
      evaluation.state,
      evaluation.band,
      evaluation.entryEffectiveAt,
      evaluation.exitEffectiveAt,
      evaluation.windowStart,
      evaluation.windowEnd,
      evaluation.qualifyingCount,
      evaluation.qualifyingGrossCents,
      evaluation.unclassifiableCount,
      policyVersion,
      version.toString(),
      evaluation.nextReevaluationAt,
      evaluation.observedAt,
    ];
    const result =
      old === undefined
        ? await db.query(
            `INSERT INTO platform_operations_seller_compliance_cohorts (seller_account_id,state,disclosure_band,entry_effective_at,exit_effective_at,window_start,window_end,qualifying_count,qualifying_gross_cents,unclassifiable_count,policy_version,version,next_reevaluation_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (seller_account_id) DO NOTHING`,
            values,
          )
        : await db.query(
            `UPDATE platform_operations_seller_compliance_cohorts SET state=$2, disclosure_band=$3, entry_effective_at=$4, exit_effective_at=$5, window_start=$6, window_end=$7, qualifying_count=$8, qualifying_gross_cents=$9, unclassifiable_count=$10, policy_version=$11, version=$12, next_reevaluation_at=$13, updated_at=$14 WHERE seller_account_id=$1 AND version=$15 AND updated_at <= $14`,
            [...values, old.version],
          );
    if (result.rowCount !== 1) return;
    for (const [index, kind] of kinds.entries()) {
      const transitionVersion = (BigInt(prior.version) + BigInt(index + 1)).toString();
      await db.query(
        `INSERT INTO platform_operations_seller_compliance_cohort_transitions (transition_id,seller_account_id,transition_version,kind,effective_at,observed_at,policy_version,target_state,target_band,published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)`,
        [
          `${input.sellerAccountId}:${transitionVersion}:${kind}`,
          input.sellerAccountId,
          transitionVersion,
          kind,
          effectiveAts[index],
          evaluation.observedAt,
          policyVersion,
          kind === "exited" ? "outside" : "member",
          kind === "entered" || kind === "exited" ? "none" : evaluation.band,
        ],
      );
    }
  });
}
