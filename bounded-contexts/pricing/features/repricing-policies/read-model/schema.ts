/**
 * RepricingPolicy read model: the policy pages table (one row per policy,
 * maintained by ../read-model/projection.ts from the aggregate's own event
 * stream) and the resolved listing -> policy ASSIGNMENT view (the repricing
 * evaluation engine's work queue input).
 *
 * The assignment relation is a VIEW, not a materialized table: it resolves
 * "most-specific wins" precedence (listing-set > catalog-filter >
 * all-listings, tie-broken by most-recently-updated policy -- see
 * domain/domain.ts's `repricingPolicyScopeSpecificity`) and per-listing
 * opt-out at query time against already-projected state
 * (`pricing_market_listing_inputs`, `pricing_catalog_item_inputs`). This
 * keeps assignment always-consistent with zero event-driven staleness risk
 * for this schema-only slice ("policy schema here; evaluation is the next
 * slice"). If a future evaluation engine needs a materialized,
 * incrementally-maintained table at 250k-listing scale, that is its call to
 * make -- this view remains a correct, always-fresh reference implementation
 * either way.
 */
export const pricingRepricingPolicySchemaSql = `
CREATE TABLE IF NOT EXISTS pricing_repricing_policies (
  policy_id text PRIMARY KEY,
  seller_account_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  scope_kind text NOT NULL,
  scope_category_ids text[] NULL,
  scope_listing_ids text[] NULL,
  excluded_listing_ids text[] NOT NULL DEFAULT '{}',
  rules jsonb NOT NULL,
  max_changes_per_day integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pricing_repricing_policies_account_idx
  ON pricing_repricing_policies (seller_account_id, status, updated_at DESC);

CREATE OR REPLACE VIEW pricing_repricing_policy_assignments AS
WITH candidate_matches AS (
  SELECT
    listing.seller_account_id,
    listing.listing_id,
    policy.policy_id,
    CASE policy.scope_kind
      WHEN 'listing-set' THEN 2
      WHEN 'catalog-filter' THEN 1
      ELSE 0
    END AS scope_specificity,
    policy.updated_at AS policy_updated_at
  FROM pricing_market_listing_inputs AS listing
  JOIN pricing_repricing_policies AS policy
    ON policy.seller_account_id = listing.seller_account_id
   AND policy.status = 'active'
  LEFT JOIN pricing_catalog_item_inputs AS catalog_item
    ON catalog_item.catalog_item_id = listing.catalog_catalog_item_id
  WHERE listing.status <> 'withdrawn'
    AND NOT (listing.listing_id = ANY (policy.excluded_listing_ids))
    AND (
      policy.scope_kind = 'all-listings'
      OR (
        policy.scope_kind = 'catalog-filter'
        AND catalog_item.category_ids IS NOT NULL
        AND catalog_item.category_ids && policy.scope_category_ids
      )
      OR (
        policy.scope_kind = 'listing-set'
        AND listing.listing_id = ANY (policy.scope_listing_ids)
      )
    )
),
ranked_matches AS (
  SELECT
    seller_account_id,
    listing_id,
    policy_id,
    scope_specificity,
    policy_updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY seller_account_id, listing_id
      ORDER BY scope_specificity DESC, policy_updated_at DESC, policy_id DESC
    ) AS precedence_rank
  FROM candidate_matches
)
SELECT
  seller_account_id,
  listing_id,
  policy_id,
  scope_specificity,
  policy_updated_at AS assigned_policy_updated_at
FROM ranked_matches
WHERE precedence_rank = 1;
`;
