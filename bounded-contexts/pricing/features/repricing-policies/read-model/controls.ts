import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { repricingCandidateCte } from "../../repricing-engine/read-model/queries";
import type { RepricingPolicyScope } from "../domain/domain";
import { candidateAssignmentSql, repricingPolicyAssignmentsSql, scopeMatchSql } from "./schema";

export async function getRepricingBudget(db: PgQueryable, accountId: string, day: string) {
  const row = (
    await db.query<{ changes_reserved: number }>(
      `SELECT changes_reserved FROM pricing_repricing_daily_change_budgets
     WHERE seller_account_id = $1 AND budget_day = $2::date`,
      [accountId, day],
    )
  ).rows[0];
  return { day, changesUsed: row?.changes_reserved ?? 0 };
}

export async function listRepricingCategories(db: PgQueryable, accountId: string) {
  return (
    await db.query<{ id: string; name: string; status: string; listingCount: number }>(
      `SELECT category.category_id AS id, category.name, category.status,
       count(listing.listing_id)::integer AS "listingCount"
     FROM pricing_catalog_category_inputs AS category
     LEFT JOIN pricing_catalog_item_inputs AS catalog_item ON category.category_id = ANY(catalog_item.category_ids)
     LEFT JOIN pricing_market_listing_inputs AS listing
       ON listing.catalog_catalog_item_id = catalog_item.catalog_item_id
       AND listing.seller_account_id = $1 AND listing.status <> 'withdrawn'
     GROUP BY category.category_id ORDER BY category.name, category.category_id`,
      [accountId],
    )
  ).rows;
}

export type RepricingScopePreviewInput = Readonly<{
  accountId: string;
  scope: RepricingPolicyScope;
  excludedListingIds?: readonly string[];
  replacingPolicyId?: string;
}>;
type PolicyCount = Readonly<{ policyId: string; name: string; count: number }>;
export type RepricingScopePreview = Readonly<{
  matching: number;
  governed: number;
  shadowedBy: readonly PolicyCount[];
  takenFrom: readonly PolicyCount[];
}>;

export async function previewRepricingScope(
  db: PgQueryable,
  input: RepricingScopePreviewInput,
): Promise<RepricingScopePreview> {
  const result = await db.query<RepricingScopePreview>(
    `WITH ${repricingCandidateCte}, remaining_assignments AS (${repricingPolicyAssignmentsSql("$2::text")}), matches AS (
       SELECT listing.listing_id, assignment.policy_id, policy.name,
         remaining.policy_id AS remaining_policy_id, remaining_policy.name AS remaining_policy_name,
         (${candidateAssignmentSql}) AND NOT EXISTS (
           SELECT 1 FROM pricing_repricing_halts AS halt
           WHERE halt.seller_account_id = candidate.seller_account_id AND halt.engaged
         ) AS governed
       FROM pricing_market_listing_inputs AS listing CROSS JOIN candidate
       LEFT JOIN pricing_catalog_item_inputs AS catalog_item ON catalog_item.catalog_item_id = listing.catalog_catalog_item_id
       LEFT JOIN pricing_repricing_policy_assignments AS assignment ON assignment.listing_id = listing.listing_id
       LEFT JOIN pricing_repricing_policies AS policy ON policy.policy_id = assignment.policy_id
       LEFT JOIN remaining_assignments AS remaining ON remaining.listing_id = listing.listing_id
       LEFT JOIN pricing_repricing_policies AS remaining_policy ON remaining_policy.policy_id = remaining.policy_id
       WHERE listing.seller_account_id = $1 AND candidate.replacing_policy_id IS NOT DISTINCT FROM $2::text
         AND listing.status <> 'withdrawn' AND ${scopeMatchSql("candidate")}
     ), affected AS (
       SELECT CASE WHEN governed THEN policy_id ELSE remaining_policy_id END AS policy_id,
         CASE WHEN governed THEN name ELSE remaining_policy_name END AS name, governed FROM matches
     ), counts AS (
       SELECT policy_id, name, governed, count(*)::integer AS count FROM affected
       WHERE policy_id IS NOT NULL AND policy_id IS DISTINCT FROM $2::text
       GROUP BY policy_id, name, governed
     ) SELECT (SELECT count(*)::integer FROM matches) AS matching,
       (SELECT count(*)::integer FROM matches WHERE governed) AS governed,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('policyId', policy_id, 'name', name, 'count', count) ORDER BY policy_id)
         FROM counts WHERE NOT governed), '[]'::jsonb) AS "shadowedBy",
       COALESCE((SELECT jsonb_agg(jsonb_build_object('policyId', policy_id, 'name', name, 'count', count) ORDER BY policy_id)
         FROM counts WHERE governed), '[]'::jsonb) AS "takenFrom"`,
    [
      input.accountId,
      input.replacingPolicyId ?? null,
      JSON.stringify({
        sellerAccountId: input.accountId,
        replacingPolicyId: input.replacingPolicyId,
        body: { scope: input.scope, excludedListingIds: input.excludedListingIds ?? [] },
      }),
    ],
  );
  return result.rows[0]!;
}
