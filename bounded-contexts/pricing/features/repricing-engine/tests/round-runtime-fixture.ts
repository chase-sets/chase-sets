import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createListingAuthorityFence } from "@chase-sets/platform-runtime/listing-authority-fence";
import { createPricingListingAuthority } from "../api/listing-authority";
import { createPricingEvaluationBudget } from "../api/listing-authority-sql";
import { createPricingProductRoundAuthority } from "../api/listing-authority-product-state";
import { createRepricingEngineRuntime as createRuntime } from "../api/runtime";

/** Real Product writer, with a separate synthetic consumer store for the preexisting engine fixtures. */
export function createRepricingEngineRuntime(deps: Omit<Parameters<typeof createRuntime>[0], "productRounds">) {
  const fence = createListingAuthorityFence({
    eventStore: createInMemoryEventStore().eventStore,
    owner: "marketplace",
    participants: [],
  });
  const authority = createPricingListingAuthority(
    { eventStore: deps.eventStore, db: deps.db, budget: createPricingEvaluationBudget(deps.db) },
    {
      consumer: () => fence.forParticipant("pricing"),
    },
  );
  return createRuntime({ ...deps, productRounds: createPricingProductRoundAuthority(deps.db, authority.source) });
}
