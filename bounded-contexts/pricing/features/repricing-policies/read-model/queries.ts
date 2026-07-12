import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { RepricingPolicyScope, RepricingPolicyStatus, RepricingRule } from "../domain/domain";

export type RepricingPolicyRecord = Readonly<{
  policyId: string;
  sellerAccountId: string;
  name: string;
  status: RepricingPolicyStatus;
  scope: RepricingPolicyScope;
  excludedListingIds: readonly string[];
  rules: readonly RepricingRule[];
  maxChangesPerDay: number;
  createdAt: string;
  updatedAt: string;
}>;

type RepricingPolicyRow = Readonly<{
  policy_id: string;
  seller_account_id: string;
  name: string;
  status: RepricingPolicyStatus;
  scope_kind: RepricingPolicyScope["kind"];
  scope_category_ids: readonly string[] | null;
  scope_listing_ids: readonly string[] | null;
  excluded_listing_ids: readonly string[];
  rules: readonly RepricingRule[] | string;
  max_changes_per_day: number;
  created_at: string;
  updated_at: string;
}>;

function scopeFromRow(row: RepricingPolicyRow): RepricingPolicyScope {
  switch (row.scope_kind) {
    case "all-listings":
      return { kind: "all-listings" };
    case "catalog-filter":
      return { kind: "catalog-filter", categoryIds: row.scope_category_ids ?? [] };
    case "listing-set":
      return { kind: "listing-set", listingIds: row.scope_listing_ids ?? [] };
    default:
      throw new Error(`Unrecognized repricing policy scope_kind: ${String(row.scope_kind)}`);
  }
}

function toRepricingPolicyRecord(row: RepricingPolicyRow): RepricingPolicyRecord {
  return {
    policyId: row.policy_id,
    sellerAccountId: row.seller_account_id,
    name: row.name,
    status: row.status,
    scope: scopeFromRow(row),
    excludedListingIds: row.excluded_listing_ids,
    rules: typeof row.rules === "string" ? (JSON.parse(row.rules) as readonly RepricingRule[]) : row.rules,
    maxChangesPerDay: row.max_changes_per_day,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const repricingPolicySelectColumns = `
  policy_id,
  seller_account_id,
  name,
  status,
  scope_kind,
  scope_category_ids,
  scope_listing_ids,
  excluded_listing_ids,
  rules,
  max_changes_per_day,
  created_at,
  updated_at
`;

export async function getRepricingPolicy(db: PgQueryable, policyId: string): Promise<RepricingPolicyRecord | null> {
  const result = await db.query<RepricingPolicyRow>(
    `SELECT ${repricingPolicySelectColumns} FROM pricing_repricing_policies WHERE policy_id = $1`,
    [policyId],
  );
  const row = result.rows[0];
  return row ? toRepricingPolicyRecord(row) : null;
}

export async function listAccountRepricingPolicies(
  db: PgQueryable,
  params: Readonly<{ accountId: string; includeDeleted?: boolean }>,
): Promise<readonly RepricingPolicyRecord[]> {
  const result = await db.query<RepricingPolicyRow>(
    `SELECT ${repricingPolicySelectColumns}
     FROM pricing_repricing_policies
     WHERE seller_account_id = $1
       AND ($2::boolean OR status <> 'deleted')
     ORDER BY updated_at DESC, policy_id DESC`,
    [params.accountId, params.includeDeleted ?? false],
  );
  return result.rows.map(toRepricingPolicyRecord);
}

export type RepricingPolicyAssignmentRow = Readonly<{
  sellerAccountId: string;
  listingId: string;
  policyId: string;
  scopeSpecificity: 0 | 1 | 2;
  assignedPolicyUpdatedAt: string;
}>;

type RawAssignmentRow = Readonly<{
  seller_account_id: string;
  listing_id: string;
  policy_id: string;
  scope_specificity: 0 | 1 | 2;
  assigned_policy_updated_at: string;
}>;

function toAssignmentRow(row: RawAssignmentRow): RepricingPolicyAssignmentRow {
  return {
    sellerAccountId: row.seller_account_id,
    listingId: row.listing_id,
    policyId: row.policy_id,
    scopeSpecificity: row.scope_specificity,
    assignedPolicyUpdatedAt: row.assigned_policy_updated_at,
  };
}

/** The repricing evaluation engine's work queue input: every listing currently resolved to an active policy. */
export async function listRepricingPolicyAssignments(
  db: PgQueryable,
  params: Readonly<{ accountId?: string; policyId?: string }>,
): Promise<readonly RepricingPolicyAssignmentRow[]> {
  if (!params.accountId && !params.policyId) {
    throw new Error("listRepricingPolicyAssignments requires accountId and/or policyId.");
  }

  const conditions: string[] = [];
  const values: unknown[] = [];
  if (params.accountId) {
    values.push(params.accountId);
    conditions.push(`seller_account_id = $${values.length}`);
  }
  if (params.policyId) {
    values.push(params.policyId);
    conditions.push(`policy_id = $${values.length}`);
  }

  const result = await db.query<RawAssignmentRow>(
    `SELECT seller_account_id, listing_id, policy_id, scope_specificity, assigned_policy_updated_at
     FROM pricing_repricing_policy_assignments
     WHERE ${conditions.join(" AND ")}
     ORDER BY listing_id`,
    values,
  );
  return result.rows.map(toAssignmentRow);
}

export async function getRepricingPolicyAssignmentForListing(
  db: PgQueryable,
  listingId: string,
): Promise<RepricingPolicyAssignmentRow | null> {
  const result = await db.query<RawAssignmentRow>(
    `SELECT seller_account_id, listing_id, policy_id, scope_specificity, assigned_policy_updated_at
     FROM pricing_repricing_policy_assignments
     WHERE listing_id = $1`,
    [listingId],
  );
  const row = result.rows[0];
  return row ? toAssignmentRow(row) : null;
}

export async function getInventoryAcquisitionCostAmount(
  db: PgQueryable,
  params: Readonly<{ sellerAccountId: string; catalogItemId: string; productId: string }>,
): Promise<string | null> {
  const result = await db.query<{ acquisition_cost_amount: string | null }>(
    `SELECT acquisition_cost_amount
     FROM pricing_inventory_item_inputs
     WHERE seller_account_id = $1
       AND catalog_catalog_item_id = $2
       AND product_id = $3
     ORDER BY updated_at DESC
     LIMIT 1`,
    [params.sellerAccountId, params.catalogItemId, params.productId],
  );
  return result.rows[0]?.acquisition_cost_amount ?? null;
}
