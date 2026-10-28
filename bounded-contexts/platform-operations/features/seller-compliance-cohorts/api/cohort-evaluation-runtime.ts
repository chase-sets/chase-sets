import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  sellerComplianceCohortPolicy,
  type SellerComplianceCohortPolicyValue,
} from "../domain/seller-compliance-cohort-policy";
import { evaluateSellerComplianceCohort } from "../domain/cohort-window";
import {
  listSellerCompletedSalesPage,
  listSellersWithChangedCompletedSales,
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
    const from = new Date(Date.parse(at));
    from.setUTCMonth(from.getUTCMonth() - (policy.lookbackMonths ?? 60));
    const sales: SellerSaleFact[] = [];
    let cursor = null;
    do {
      const page = await listSellerCompletedSalesPage(deps.db, {
        sellerAccountId,
        fromInclusive: from.toISOString(),
        toExclusive: at,
        cursor,
        limit: 100,
      });
      sales.push(...page.sales);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return sales;
  }

  async function evaluateSeller(sellerAccountId: string, evaluationAt: string): Promise<boolean> {
    let resolved;
    try {
      resolved = await deps.policies.resolvePolicy(sellerComplianceCohortPolicy, { at: evaluationAt });
    } catch (error) {
      await deps.db.query(
        `INSERT INTO platform_operations_seller_compliance_evaluation_failures (seller_account_id,evaluation_at,failure_kind,detail,policy_version) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [
          sellerAccountId,
          evaluationAt,
          "policy-resolution",
          error instanceof Error ? error.message : String(error),
          null,
        ],
      );
      return false;
    }
    const policy = resolved.value;
    if (!policy.activated) return false;
    const sales = await loadSales(sellerAccountId, evaluationAt, policy);
    const previous = await readSellerComplianceCohort(deps.db, sellerAccountId);
    const evaluation = evaluateSellerComplianceCohort({
      sales,
      policy,
      evaluationAt,
      previous: previous
        ? {
            state: previous.state as "outside" | "member",
            band: previous.band as "none" | "disclosure",
            entryEffectiveAt: null,
          }
        : undefined,
    });
    if (!previous && evaluation.state === "outside") return false;
    await writeSellerComplianceCohort(deps.pool, {
      sellerAccountId,
      policyVersion: resolved.documentId ?? "fallback",
      observedAt: evaluationAt,
      evaluation,
    });
    return true;
  }

  async function sweep(params: Readonly<{ now?: string; limit?: number }> = {}): Promise<number> {
    const now = params.now ?? new Date().toISOString();
    const policy = (await deps.policies.resolvePolicy(sellerComplianceCohortPolicy, { at: now })).value;
    if (!policy.activated) return 0;
    const from = new Date(Date.parse(now));
    from.setUTCDate(from.getUTCDate() - 1);
    const page = await listSellersWithChangedCompletedSales(deps.db, {
      fromInclusive: from.toISOString(),
      toExclusive: now,
      snapshotChangeSequence: "9223372036854775807",
      limit: params.limit ?? 100,
    });
    const due = await deps.db.query<{ seller_account_id: string }>(
      `SELECT seller_account_id FROM platform_operations_seller_compliance_cohorts WHERE next_reevaluation_at <= $1 OR policy_version <> $2 LIMIT $3`,
      [now, "fallback", params.limit ?? 100],
    );
    const historical = await deps.db.query<{ seller_account_id: string }>(
      `SELECT DISTINCT s.seller_account_id FROM platform_operations_seller_compliance_sales s LEFT JOIN platform_operations_seller_compliance_cohorts c ON c.seller_account_id = s.seller_account_id WHERE s.recorded_at IS NOT NULL AND s.occurred_at >= $1 AND s.occurred_at < $2 AND c.seller_account_id IS NULL LIMIT $3`,
      [new Date(Date.UTC(new Date(Date.parse(now)).getUTCFullYear(), new Date(Date.parse(now)).getUTCMonth() - (policy.lookbackMonths ?? 60), new Date(Date.parse(now)).getUTCDate())).toISOString(), now, params.limit ?? 100],
    );
    const sellers = [...new Set([...page.sellerAccountIds, ...due.rows.map((row) => row.seller_account_id), ...historical.rows.map((row) => row.seller_account_id)])].slice(0, params.limit ?? 100);
    let processed = 0;
    for (const seller of sellers) {
      await evaluateSeller(seller, now);
      processed += 1;
    }
    return processed;
  }

  return { evaluateSeller, sweep };
}
