// Pricing's contribution to the Seller Desk attention queue — the Repricing
// Attention Source (`pricing-repricing`). It maps the account-scoped repricing
// attention summary into queue items; every count comes from that summary, and
// the frozen state comes from the retained listing-outcome rows, never a live
// breaker read. All items deep-link to the Desk repricing policy list.

import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import {
  buildSellerAttentionItem,
  type SellerAttentionContext,
  type SellerAttentionItem,
  type SellerAttentionSource,
} from "@chase-sets/seller-attention-queue";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createRepricingActivityServices } from "../api/activity-route";
import type { getRepricingAttentionSummary } from "../api/activity";

export type RepricingAttentionSummary = Awaited<ReturnType<typeof getRepricingAttentionSummary>>;

// Pure mapping: one attention summary → attention items. Entity ids are stable
// per condition so an item keeps its id across reloads while the condition holds.
export function toRepricingAttentionItems(
  summary: RepricingAttentionSummary,
  context: SellerAttentionContext,
): readonly SellerAttentionItem[] {
  const items: SellerAttentionItem[] = [];
  if (summary.haltEngaged) {
    items.push(
      buildSellerAttentionItem({
        source: "pricing-repricing",
        entityId: "halt",
        severity: "warning",
        summary: { code: "repricing-halt-engaged", params: {} },
        observedAt: context.now,
      }),
    );
  }
  if (summary.floorBinding > 0) {
    items.push(
      buildSellerAttentionItem({
        source: "pricing-repricing",
        entityId: "floor-binding",
        severity: "warning",
        summary: { code: "repricing-floor-binding", params: { count: summary.floorBinding } },
        observedAt: context.now,
      }),
    );
  }
  if (summary.pausedForMissingInput > 0) {
    items.push(
      buildSellerAttentionItem({
        source: "pricing-repricing",
        entityId: "paused-for-missing-input",
        severity: "warning",
        summary: { code: "repricing-paused-for-missing-input", params: { count: summary.pausedForMissingInput } },
        observedAt: context.now,
      }),
    );
  }
  for (const budget of summary.budgetExhaustedToday) {
    items.push(
      buildSellerAttentionItem({
        source: "pricing-repricing",
        entityId: `budget-exhausted:${budget.policyId}`,
        severity: "info",
        summary: { code: "repricing-budget-exhausted", params: { count: budget.count } },
        observedAt: context.now,
      }),
    );
  }
  for (const frozen of summary.frozenProducts) {
    items.push(
      buildSellerAttentionItem({
        source: "pricing-repricing",
        entityId: `frozen:${frozen.productKey.catalogItemId}:${frozen.productKey.productId}`,
        severity: "info",
        summary: { code: "repricing-frozen", params: { count: frozen.listingCount } },
        observedAt: context.now,
      }),
    );
  }
  return items;
}

export type RepricingAttentionSourceDependencies = Readonly<{
  loadSummary: (context: SellerAttentionContext) => Promise<RepricingAttentionSummary>;
}>;

export function createRepricingAttentionSource(dependencies: RepricingAttentionSourceDependencies): SellerAttentionSource {
  return {
    id: "pricing-repricing",
    load: async (context) => toRepricingAttentionItems(await dependencies.loadSummary(context), context),
  };
}

export function createRepricingAttentionSourceFromReadModel(
  db: PgQueryable,
  policies: Pick<PolicyRuntime, "resolvePolicy"> = createPolicyResolver({ db }),
): SellerAttentionSource {
  const services = createRepricingActivityServices({ db, policies });
  return createRepricingAttentionSource({
    loadSummary: (context) => services.attention(context.accountId, context.now),
  });
}
