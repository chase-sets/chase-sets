import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { marketplaceSellerBehavioralMetricsPolicy } from "../domain/behavioral-metrics-policy";
import {
  getSellerBehavioralMetricsChips,
  getSellerBehavioralMetricsSummary,
  type SellerBehavioralMetricsChips,
  type SellerBehavioralMetricsSummaryRow,
} from "../read-model/queries";

type SellerMetricsRuntimeDeps = Readonly<{
  db: PgQueryable;
  policies: Pick<PolicyRuntime, "resolvePolicy">;
}>;

export type SellerMetricsServices = Readonly<{
  /** Own-account seller dashboard read: full counts and rates, gated to the caller's own account by the route layer. */
  getOwnBehavioralMetrics: (sellerAccountId: string) => Promise<SellerBehavioralMetricsSummaryRow | null>;
  /** Public buyer-facing read: threshold-gated qualitative chips only, flag-gated by the route layer. */
  getPublicBehavioralMetricsChips: (sellerAccountId: string) => Promise<SellerBehavioralMetricsChips>;
  /** Whether buyer-facing chips are currently enabled (the policy's rollout gate). */
  isBuyerFacingChipsEnabled: () => Promise<boolean>;
}>;

export function createSellerMetricsRuntime(deps: SellerMetricsRuntimeDeps): SellerMetricsServices {
  async function resolvedPolicyValue() {
    const resolved = await deps.policies.resolvePolicy(marketplaceSellerBehavioralMetricsPolicy);
    return resolved.value;
  }

  return {
    getOwnBehavioralMetrics: (sellerAccountId) => getSellerBehavioralMetricsSummary(deps.db, sellerAccountId),
    getPublicBehavioralMetricsChips: async (sellerAccountId) => {
      const policyValue = await resolvedPolicyValue();
      return getSellerBehavioralMetricsChips(deps.db, sellerAccountId, policyValue.minDisplayOrderCount);
    },
    isBuyerFacingChipsEnabled: async () => (await resolvedPolicyValue()).buyerFacingChipsEnabled,
  };
}
