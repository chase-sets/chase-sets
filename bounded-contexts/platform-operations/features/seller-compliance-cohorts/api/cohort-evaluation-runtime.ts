import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  sellerComplianceCohortPolicy,
  SellerComplianceCohortPolicyDomainError,
  type SellerComplianceCohortPolicyValue,
} from "../domain/seller-compliance-cohort-policy";
import { evaluateSellerComplianceCohort, addUtcMonths } from "../domain/cohort-window";
import {
  listSellerCompletedSalesPage,
  listSellersWithChangedCompletedSales,
  listSellersWithSalesOccurringInWindow,
  readSellerComplianceSnapshotChangeSequence,
  type SellerSaleFact,
} from "../../seller-compliance-sales/read-model/queries";
import { readSellerComplianceCohort, writeSellerComplianceCohort } from "../read-model/cohort-store";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";

export function createSellerComplianceCohortRuntime(
  deps: Readonly<{ db: PgQueryable; pool: PgTransactionalPool; policies: Pick<PolicyRuntime, "resolvePolicy"> }>,
) {
  async function loadSales(
    sellerAccountId: string,
    at: string,
    policy: SellerComplianceCohortPolicyValue,
  ): Promise<readonly SellerSaleFact[]> {
    const from = addUtcMonths(at, -(policy.lookbackMonths ?? 60));
    const sales: SellerSaleFact[] = [];
    let cursor = null;
    do {
      const page = await listSellerCompletedSalesPage(deps.db, {
        sellerAccountId,
        fromInclusive: from,
        toExclusive: at,
        cursor,
        limit: 100,
      });
      sales.push(...page.sales);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return sales;
  }
  async function recordFailure(
    sellerAccountId: string,
    evaluationAt: string,
    detail: string,
    policyVersion: string | null,
    kind = "policy-resolution",
  ) {
    await deps.db.query(
      `INSERT INTO platform_operations_seller_compliance_evaluation_failures (seller_account_id,evaluation_at,failure_kind,detail,policy_version) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [sellerAccountId, evaluationAt, kind, detail, policyVersion],
    );
  }
  async function evaluateSeller(
    sellerAccountId: string,
    evaluationAt: string,
    resolved?: Readonly<{ value: SellerComplianceCohortPolicyValue; version: string }>,
    revisionEffectiveAt?: string,
  ): Promise<boolean> {
    let current = resolved;
    if (!current) {
      try {
        const value = await deps.policies.resolvePolicy(sellerComplianceCohortPolicy, { at: evaluationAt });
        current = {
          value: value.value,
          version: value.documentId ? `${value.documentId}@${value.effectiveFrom ?? "unknown"}` : "fallback",
        };
      } catch (error) {
        await recordFailure(
          sellerAccountId,
          evaluationAt,
          error instanceof Error ? error.message : String(error),
          null,
        );
        return false;
      }
    }
    if (!current.value.activated) return false;
    const sales = await loadSales(sellerAccountId, evaluationAt, current.value);
    const previous = await readSellerComplianceCohort(deps.db, sellerAccountId);
    const evaluation = evaluateSellerComplianceCohort({
      sales,
      policy: current.value,
      evaluationAt,
      revisionEffectiveAt,
      previous: previous
        ? {
            state: previous.state as "outside" | "member",
            band: previous.band as "none" | "disclosure",
            entryEffectiveAt: previous.entryEffectiveAt,
            exitEffectiveAt: previous.exitEffectiveAt,
          }
        : undefined,
    });
    if (!previous && evaluation.state === "outside") return false;
    await writeSellerComplianceCohort(deps.pool, {
      sellerAccountId,
      policyVersion: current.version,
      observedAt: evaluationAt,
      evaluation,
    });
    return true;
  }
  type Trigger = "t1-changed" | "t2-due" | "t3-revision";
  type Candidate = Readonly<{ sellerAccountId: string; trigger: Trigger }>;

  async function checkpoint(trigger: Trigger) {
    const result = await deps.db.query<{
      snapshot_change_sequence: string;
      after_seller_account_id: string | null;
      policy_version: string;
    }>(
      `SELECT snapshot_change_sequence::text, after_seller_account_id, policy_version FROM platform_operations_seller_compliance_sweep_checkpoints WHERE trigger_name = $1`,
      [trigger],
    );
    return result.rows[0] ?? null;
  }

  async function candidateSellers(
    now: string,
    limit: number,
    snapshot: string,
    policy: SellerComplianceCohortPolicyValue,
    policyVersion: string,
    trigger: Trigger,
  ): Promise<{ candidates: Candidate[]; snapshot: string; full: boolean }> {
    const from = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
    const saved = await checkpoint(trigger);
    const after = saved && saved.snapshot_change_sequence === snapshot ? saved.after_seller_account_id : null;
    if (trigger === "t1-changed") {
      const changed = await listSellersWithChangedCompletedSales(deps.db, {
        fromInclusive: from,
        toExclusive: now,
        snapshotChangeSequence: snapshot,
        afterSellerAccountId: after,
        limit,
      });
      return {
        candidates: changed.sellerAccountIds.map((sellerAccountId) => ({ sellerAccountId, trigger })),
        snapshot,
        full: changed.sellerAccountIds.length === limit,
      };
    }
    if (trigger === "t2-due") {
      const due = await deps.db.query<{ seller_account_id: string }>(
        `SELECT seller_account_id FROM platform_operations_seller_compliance_cohorts WHERE next_reevaluation_at <= $1 AND ($2::text IS NULL OR seller_account_id > $2::text) ORDER BY seller_account_id ASC LIMIT $3`,
        [now, after, limit],
      );
      return {
        candidates: due.rows.map((row) => ({ sellerAccountId: row.seller_account_id, trigger })),
        snapshot,
        full: due.rows.length === limit,
      };
    }
    const revision = await deps.db.query<{ seller_account_id: string }>(
      `SELECT seller_account_id FROM platform_operations_seller_compliance_cohorts WHERE policy_version <> $1 AND ($2::text IS NULL OR seller_account_id > $2::text) ORDER BY seller_account_id ASC LIMIT $3`,
      [policyVersion, after, limit],
    );
    const ids = new Set(revision.rows.map((row) => row.seller_account_id));
    if (!saved || saved.policy_version !== policyVersion) {
      const occurrence = await listSellersWithSalesOccurringInWindow(deps.db, {
        fromInclusive: addUtcMonths(now, -(policy.lookbackMonths ?? 60)),
        toExclusive: now,
        snapshotChangeSequence: snapshot,
        afterSellerAccountId: after,
        limit,
      });
      occurrence.sellerAccountIds.forEach((id) => ids.add(id));
    }
    const candidates = [...ids]
      .sort()
      .slice(0, limit)
      .map((sellerAccountId) => ({ sellerAccountId, trigger }));
    return { candidates, snapshot, full: candidates.length === limit };
  }
  async function sweep(params: Readonly<{ now?: string; limit?: number }> = {}): Promise<number> {
    const now = params.now ?? new Date().toISOString();
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 100);
    let resolved;
    try {
      const value = await deps.policies.resolvePolicy(sellerComplianceCohortPolicy, { at: now });
      resolved = {
        value: value.value,
        version: value.documentId ? `${value.documentId}@${value.effectiveFrom ?? "unknown"}` : "fallback",
        effectiveFrom: value.effectiveFrom,
      };
    } catch (error) {
      const existing = await deps.db.query<{ seller_account_id: string }>(
        `SELECT seller_account_id FROM platform_operations_seller_compliance_cohorts ORDER BY seller_account_id ASC LIMIT $1`,
        [limit],
      );
      const changed = await listSellersWithChangedCompletedSales(deps.db, {
        fromInclusive: new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString(),
        toExclusive: now,
        snapshotChangeSequence: await readSellerComplianceSnapshotChangeSequence(deps.db),
        afterSellerAccountId: null,
        limit,
      });
      const ids = [
        ...new Set([...existing.rows.map((row) => row.seller_account_id), ...changed.sellerAccountIds]),
      ].slice(0, limit);
      const kind = error instanceof SellerComplianceCohortPolicyDomainError ? "policy-decode" : "policy-resolution";
      for (const seller of ids)
        await recordFailure(seller, now, error instanceof Error ? error.message : String(error), null, kind);
      return ids.length;
    }
    if (!resolved.value.activated) return 0;
    const snapshot = await readSellerComplianceSnapshotChangeSequence(deps.db);
    let processed = 0;
    const evaluated = new Set<string>();
    for (const trigger of ["t1-changed", "t2-due", "t3-revision"] as const) {
      const page = await candidateSellers(now, limit - processed, snapshot, resolved.value, resolved.version, trigger);
      const evaluationAt = trigger === "t3-revision" && resolved.effectiveFrom ? resolved.effectiveFrom : now;
      for (const candidate of page.candidates) {
        if (evaluated.has(candidate.sellerAccountId)) continue;
        await evaluateSeller(
          candidate.sellerAccountId,
          evaluationAt,
          { value: resolved.value, version: resolved.version },
          trigger === "t3-revision" ? (resolved.effectiveFrom ?? undefined) : undefined,
        );
        evaluated.add(candidate.sellerAccountId);
        processed += 1;
      }
      if (page.full && page.candidates.length > 0) {
        await deps.db.query(
          `INSERT INTO platform_operations_seller_compliance_sweep_checkpoints (trigger_name,snapshot_change_sequence,after_seller_account_id,policy_version,updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (trigger_name) DO UPDATE SET snapshot_change_sequence=$2, after_seller_account_id=$3, policy_version=$4, updated_at=$5`,
          [trigger, page.snapshot, page.candidates[page.candidates.length - 1]!.sellerAccountId, resolved.version, now],
        );
      } else {
        await deps.db.query(
          `DELETE FROM platform_operations_seller_compliance_sweep_checkpoints WHERE trigger_name = $1`,
          [trigger],
        );
      }
      if (processed >= limit) break;
    }
    return processed;
  }
  return { evaluateSeller, sweep };
}
