import type { PgQueryable } from "@chase-sets/event-core-postgres";

export async function readSellerComplianceCohortState(db: PgQueryable, sellerAccountId: string) {
  const result = await db.query(
    `SELECT seller_account_id, state, disclosure_band, entry_effective_at, exit_effective_at, window_start, window_end, qualifying_count, qualifying_gross_cents::text, unclassifiable_count, policy_version, version::text, next_reevaluation_at FROM platform_operations_seller_compliance_cohorts WHERE seller_account_id = $1`,
    [sellerAccountId],
  );
  return result.rows[0] ?? null;
}

export async function readSellerComplianceUnclassifiableCoverage(db: PgQueryable, sellerAccountId: string) {
  const result = await db.query<{ unclassifiable_count: string; total_count: string }>(
    `SELECT COALESCE(unclassifiable_count,0)::text AS unclassifiable_count, COALESCE(unclassifiable_count + qualifying_count,0)::text AS total_count FROM platform_operations_seller_compliance_cohorts WHERE seller_account_id = $1`,
    [sellerAccountId],
  );
  return result.rows[0] ?? { unclassifiable_count: "0", total_count: "0" };
}
