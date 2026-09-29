import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createListingAuthorityFence } from "@chase-sets/platform-runtime/listing-authority-fence";

/** Read/projection fixtures mount a real, separate synthetic terminal store, never an allowing stub. */
export function syntheticPricingConsumer() {
  return createListingAuthorityFence({
    owner: "marketplace",
    participants: [],
    eventStore: createInMemoryEventStore().eventStore,
  }).forParticipant("pricing");
}
