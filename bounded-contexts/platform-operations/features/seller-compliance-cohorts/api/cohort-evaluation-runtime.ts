import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  sellerComplianceCohortPolicy,
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
  async function candidateSellers(
    now: string,
    limit: number,
    snapshot: string,
    policy: SellerComplianceCohortPolicyValue,
    policyVersion: string,
    afterSellerAccountId: string | null,
  ): Promise<string[]> {
    const from = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
    const ids = new Set<string>();
    const changed = await listSellersWithChangedCompletedSales(deps.db, {
      fromInclusive: from,
      toExclusive: now,
      snapshotChangeSequence: snapshot,
      afterSellerAccountId,
      limit,
    });
    changed.sellerAccountIds.forEach((id) => ids.add(id));
    const due = await deps.db.query<{ seller_account_id: string }>(
      `SELECT seller_account_id FROM platform_operations_seller_compliance_cohorts WHERE (next_reevaluation_at <= $1 OR policy_version <> $4) AND ($3::text IS NULL OR seller_account_id > $3::text) ORDER BY seller_account_id ASC LIMIT $2`,
      [now, limit, afterSellerAccountId, policyVersion],
    );
    due.rows.forEach((row) => ids.add(row.seller_account_id));
    const occurrence = await listSellersWithSalesOccurringInWindow(deps.db, {
      fromInclusive: addUtcMonths(now, -(policy.lookbackMonths ?? 60)),
      toExclusive: now,
      snapshotChangeSequence: snapshot,
      afterSellerAccountId,
      limit,
    });
    occurrence.sellerAccountIds.forEach((id) => ids.add(id));
    return [...ids].sort().slice(0, limit);
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
      const candidates = await deps.db.query<{ seller_account_id: string }>(
        `SELECT seller_account_id FROM platform_operations_seller_compliance_cohorts ORDER BY seller_account_id ASC LIMIT $1`,
        [limit],
      );
      for (const row of candidates.rows)
        await recordFailure(row.seller_account_id, now, error instanceof Error ? error.message : String(error), null);
      return candidates.rows.length;
    }
    if (!resolved.value.activated) return 0;
    const checkpoint = await deps.db.query<{
      snapshot_change_sequence: string;
      after_seller_account_id: string | null;
    }>(
      `SELECT snapshot_change_sequence::text, after_seller_account_id FROM platform_operations_seller_compliance_sweep_checkpoints WHERE trigger_name = $1`,
      ["cohort-sweep"],
    );
    const snapshot =
      checkpoint.rows[0]?.snapshot_change_sequence ?? (await readSellerComplianceSnapshotChangeSequence(deps.db));
    const afterSellerAccountId = checkpoint.rows[0]?.after_seller_account_id ?? null;
    const sellers = await candidateSellers(
      now,
      limit,
      snapshot,
      resolved.value,
      resolved.version,
      afterSellerAccountId,
    );
    const evaluationAt =
      resolved.effectiveFrom && Date.parse(resolved.effectiveFrom) <= Date.parse(now) ? resolved.effectiveFrom : now;
    let processed = 0;
    for (const seller of sellers) {
      await evaluateSeller(seller, evaluationAt, { value: resolved.value, version: resolved.version });
      processed += 1;
    }
    if (sellers.length === limit) {
      await deps.db.query(
        `INSERT INTO platform_operations_seller_compliance_sweep_checkpoints (trigger_name,snapshot_change_sequence,after_seller_account_id,policy_version,updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (trigger_name) DO UPDATE SET snapshot_change_sequence=$2, after_seller_account_id=$3, policy_version=$4, updated_at=$5`,
        ["cohort-sweep", snapshot, sellers[sellers.length - 1], resolved.version, now],
      );
    } else {
      await deps.db.query(
        `DELETE FROM platform_operations_seller_compliance_sweep_checkpoints WHERE trigger_name = $1`,
        ["cohort-sweep"],
      );
    }
    return processed;
  }
  return { evaluateSeller, sweep };
}
