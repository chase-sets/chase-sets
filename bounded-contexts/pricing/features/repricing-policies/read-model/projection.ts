import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { RepricingPolicyScope, RepricingRule } from "../domain/domain";

const repricingPolicyStreamIdPrefix = "pricing.repricing-policy-";

function policyIdFromStreamId(streamId: string): string {
  return extractIdFromStreamId(streamId, repricingPolicyStreamIdPrefix);
}

function scopeColumns(scope: RepricingPolicyScope): Readonly<{
  scopeKind: string;
  scopeCategoryIds: readonly string[] | null;
  scopeListingIds: readonly string[] | null;
}> {
  switch (scope.kind) {
    case "all-listings":
      return { scopeKind: "all-listings", scopeCategoryIds: null, scopeListingIds: null };
    case "catalog-filter":
      return { scopeKind: "catalog-filter", scopeCategoryIds: scope.categoryIds, scopeListingIds: null };
    case "listing-set":
      return { scopeKind: "listing-set", scopeCategoryIds: null, scopeListingIds: scope.listingIds };
    default:
      throw new Error(`Unrecognized repricing policy scope: ${JSON.stringify(scope)}`);
  }
}

export function buildRepricingPolicyProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "pricing.repricing-policy.created": async (event) => {
      const data = event.data as {
        policyId: string;
        accountId: string;
        name: string;
        scope: RepricingPolicyScope;
        excludedListingIds: readonly string[];
        rules: readonly RepricingRule[];
        maxChangesPerDay: number;
        createdAt: string;
      };
      const { scopeKind, scopeCategoryIds, scopeListingIds } = scopeColumns(data.scope);

      await db.query(
        `INSERT INTO pricing_repricing_policies (
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
         ) VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, $9, $10, $10)
         ON CONFLICT (policy_id) DO NOTHING`,
        [
          data.policyId,
          data.accountId,
          data.name,
          scopeKind,
          scopeCategoryIds,
          scopeListingIds,
          data.excludedListingIds,
          JSON.stringify(data.rules),
          data.maxChangesPerDay,
          data.createdAt,
        ],
      );
    },
    "pricing.repricing-policy.revised": async (event) => {
      const data = event.data as {
        name: string;
        scope: RepricingPolicyScope;
        excludedListingIds: readonly string[];
        rules: readonly RepricingRule[];
        maxChangesPerDay: number;
        revisedAt: string;
      };
      const { scopeKind, scopeCategoryIds, scopeListingIds } = scopeColumns(data.scope);

      await db.query(
        `UPDATE pricing_repricing_policies
         SET name = $2,
             scope_kind = $3,
             scope_category_ids = $4,
             scope_listing_ids = $5,
             excluded_listing_ids = $6,
             rules = $7,
             max_changes_per_day = $8,
             updated_at = $9
         WHERE policy_id = $1`,
        [
          policyIdFromStreamId(event.streamId),
          data.name,
          scopeKind,
          scopeCategoryIds,
          scopeListingIds,
          data.excludedListingIds,
          JSON.stringify(data.rules),
          data.maxChangesPerDay,
          data.revisedAt,
        ],
      );
    },
    "pricing.repricing-policy.paused": async (event) => {
      const data = event.data as { pausedAt: string };
      await db.query(
        `UPDATE pricing_repricing_policies
         SET status = 'paused',
             updated_at = $2
         WHERE policy_id = $1`,
        [policyIdFromStreamId(event.streamId), data.pausedAt],
      );
    },
    "pricing.repricing-policy.resumed": async (event) => {
      const data = event.data as { resumedAt: string };
      await db.query(
        `UPDATE pricing_repricing_policies
         SET status = 'active',
             updated_at = $2
         WHERE policy_id = $1`,
        [policyIdFromStreamId(event.streamId), data.resumedAt],
      );
    },
    "pricing.repricing-policy.deleted": async (event) => {
      const data = event.data as { deletedAt: string };
      await db.query(
        `UPDATE pricing_repricing_policies
         SET status = 'deleted',
             updated_at = $2
         WHERE policy_id = $1`,
        [policyIdFromStreamId(event.streamId), data.deletedAt],
      );
    },
  };
}

export const repricingPolicyStreamId = (policyId: string): string => `${repricingPolicyStreamIdPrefix}${policyId}`;
