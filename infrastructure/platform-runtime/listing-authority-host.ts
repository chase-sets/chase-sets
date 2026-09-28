import type { EventStore } from "@chase-sets/event-core/event-store";
import {
  listingAuthorityParticipantKey,
  type ListingAuthorityOperation,
  type ListingAuthorityOwner,
  type ListingAuthorityParticipant,
  type ListingAuthorityParticipantPort,
} from "@chase-sets/event-core/listing-authority";
import { createListingAuthorityFence } from "./listing-authority-fence";

/** Source identity comes from host composition, never from an operation/header. */
export function createListingAuthorityConsumerResolver(
  stores: Partial<Readonly<Record<ListingAuthorityOperation["committingOwner"], EventStore>>>,
  sourceOwner: ListingAuthorityOwner,
) {
  const consumers = new Map(
    Object.entries(stores).map(([owner, eventStore]) => [
      owner,
      createListingAuthorityFence({
        eventStore,
        owner: owner as ListingAuthorityOperation["committingOwner"],
        participants: [],
      }).forParticipant(sourceOwner),
    ]),
  );
  return (operation: ListingAuthorityOperation) => {
    const consumer = consumers.get(operation.committingOwner);
    if (!consumer) throw new Error(`${operation.committingOwner} Listing authority terminal is not mounted.`);
    return consumer;
  };
}

/** Resolve after all owner services are constructed, while keeping the port identity fixed. */
export function bindListingAuthorityParticipant<const P extends ListingAuthorityParticipant>(
  participant: P,
  resolve: () => ListingAuthorityParticipantPort,
): ListingAuthorityParticipantPort & Readonly<{ participant: P }> {
  const current = () => {
    const port = resolve();
    if (listingAuthorityParticipantKey(port.participant) !== listingAuthorityParticipantKey(participant))
      throw new Error("Mounted Listing authority participant identity changed.");
    return port;
  };
  return {
    participant,
    prepare: (operation, context) => current().prepare(operation, context),
    inspect: (operation) => current().inspect(operation),
    settle: (operation) => current().settle(operation),
  };
}
