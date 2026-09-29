import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgTransactionalPool, PostgresEventStore } from "@chase-sets/event-core-postgres";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createRepricingPolicyRuntime } from "../../repricing-policies/api/runtime";
import { createRepricingPolicyActivationServices } from "../../repricing-policies/api/activation";
import { createMarketEstimatesRuntime } from "../../market-estimates/api/runtime";
import { createPricingListingAuthority, type PricingListingAuthorityPorts } from "./listing-authority";
import { createPricingEvaluationBudget } from "./listing-authority-sql";
import { createPricingProductRoundAuthority } from "./listing-authority-product-state";

/** Writer-first composition. The live round invokes Product mutations only after durable admission,
 * outside database locks. Granting consumers remain disabled until their post-freeze migration.
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
