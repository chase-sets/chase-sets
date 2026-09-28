import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgTransactionalPool, PostgresEventStore } from "@chase-sets/event-core-postgres";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createRepricingPolicyRuntime } from "../../repricing-policies/api/runtime";
import { createRepricingPolicyActivationServices } from "../../repricing-policies/api/activation";
import { createMarketEstimatesRuntime } from "../../market-estimates/api/runtime";
import { createPricingListingAuthority, type PricingListingAuthorityPorts } from "./listing-authority";
import { createPricingEvaluationBudget } from "./listing-authority-sql";
import { createPricingProductRoundAuthority } from "./listing-authority-product-state";

/** Owner composition for the writer-first rollout. Mount this entire set, never only the granting port.
 * The legacy live gateway/round executor is deliberately not mounted here: its consumer migration
 * follows A's final freeze, and must invoke Product mutations outside its old session advisory lock.
 */
export function createPricingListingAuthorityWriters(
  deps: Readonly<{
    eventStore: EventStore & Pick<PostgresEventStore, "appendToStreamInTransaction">;
    pool: PgTransactionalPool;
  }>,
  ports: PricingListingAuthorityPorts,
) {
  const authority = createPricingListingAuthority(
    {
      eventStore: deps.eventStore,
      db: deps.pool,
      budget: createPricingEvaluationBudget(deps.pool),
    },
    ports,
  );
  const policies = createPolicyRuntime({ eventStore: authority.eventStore, db: deps.pool });
  const repricingPolicies = {
    ...createRepricingPolicyRuntime({ eventStore: authority.eventStore, db: deps.pool }),
    ...createRepricingPolicyActivationServices({
      eventStore: deps.eventStore,
      pool: deps.pool,
      authority: authority.source,
    }),
  };
  const marketEstimates = createMarketEstimatesRuntime({ eventStore: authority.eventStore, db: deps.pool, policies });
  const productRounds = createPricingProductRoundAuthority(deps.pool, authority.source);
  return { authority, policies, repricingPolicies, marketEstimates, productRounds };
}

export type PricingListingAuthorityWriters = ReturnType<typeof createPricingListingAuthorityWriters>;
