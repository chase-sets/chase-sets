import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  ListingAuthorityOperation,
  ListingAuthorityParticipant,
  ListingAuthorityPurpose,
} from "@chase-sets/event-core/listing-authority";
import { createListingAuthorityFence } from "@chase-sets/platform-runtime/listing-authority-fence";
import { createListingAuthorityParticipant } from "@chase-sets/platform-runtime/listing-authority-participant";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { ListingTargetAuthority } from "./target-contracts";

/** Synthetic domain facts; real durable participant APIs and separate owner stores. */
export function createSyntheticListingAuthority(consumerStore: EventStore) {
  const definitions: readonly ListingAuthorityParticipant[] = [
    { owner: "identity", purpose: "manage-listing" },
    { owner: "channels", purpose: "connection" },
    { owner: "pricing", purpose: "evaluated-price" },
    { owner: "inventory", purpose: "stock-allocation" },
    { owner: "catalog", purpose: "product-measures" },
    { owner: "marketplace", purpose: "native-readiness" },
    { owner: "commercial-terms", purpose: "native-fee" },
    { owner: "marketplace", purpose: "native-commitment" },
  ];
  const stores = new Map(
    definitions.map(({ owner }) => [
      owner,
      owner === "marketplace" ? consumerStore : createInMemoryEventStore().eventStore,
    ]),
  );
  const sources = definitions.map((participant) => {
    const eventStore = stores.get(participant.owner)!;
    const streamId = `${participant.owner}.synthetic-${participant.purpose}`;
    return createListingAuthorityParticipant({
      eventStore,
      participant,
      consumer: () =>
        createListingAuthorityFence({
          eventStore: consumerStore,
          owner: "marketplace",
          participants: [],
        }).forParticipant(participant.owner),
      resources: (operation) => [`${operation.accountId}/${participant.purpose}`],
      validate: async (operation, context) => {
        const events = await readCompleteStream(eventStore, { streamId });
        if (events.at(-1)?.payload.enabled === false) throw new Error("Synthetic source authority revoked.");
        return {
          value: {},
          sourceRevisions: [{ resourceId: streamId, revision: String(events.length) }],
          validBefore: operation.prepareBefore,
          localAppends: [{ streamId, expectedVersion: events.length, context, events: [] }],
        };
      },
    });
  });
  async function reserve(
    purpose: ListingAuthorityPurpose,
    operation: ListingAuthorityOperation,
    context?: EventStoreContext,
  ) {
    const source = sources.find((candidate) => candidate.participant.purpose === purpose)!;
    return [
      await source.prepare(
        operation,
        context ?? {
          tenantId: operation.tenantId as EventStoreContext["tenantId"],
          audit: {
            forAccountId: operation.accountId as EventStoreContext["audit"]["forAccountId"],
            performedByUserId: operation.actor.userId as EventStoreContext["audit"]["performedByUserId"],
          },
        },
      ),
    ];
  }
  async function change(purpose: ListingAuthorityPurpose, context: EventStoreContext, enabled = true) {
    const source = sources.find((candidate) => candidate.participant.purpose === purpose)!;
    const eventStore = stores.get(source.participant.owner)!;
    const streamId = `${source.participant.owner}.synthetic-${purpose}`;
    const prior = await readCompleteStream(eventStore, { streamId });
    await source.mutate({
      resources: [`${context.audit.forAccountId}/${purpose}`],
      mutationId: `${purpose}-${prior.length + 1}`,
      command: { enabled },
      context,
      prepare: async () => [
        {
          streamId,
          expectedVersion: prior.length,
          context,
          events: [{ eventType: `${source.participant.owner}.synthetic-authority-changed`, payload: { enabled } }],
        },
      ],
    });
  }
  const authority: ListingTargetAuthority = {
    participants: sources,
    resolveActor: async (context) => ({ kind: "user", userId: context.audit.performedByUserId }),
    authorizeManage: async (_input, context, operation) => ({
      value: true,
      reservations: await reserve("manage-listing", operation, context),
    }),
    verifyDecision: async (_input, context, operation) => ({
      value: true,
      reservations: await reserve("evaluated-price", operation, context),
    }),
    resolveConnection: async ({ accountId, connectionId }, operation) => ({
      value: {
        accountId,
        connectionId,
        providerKey: "synthetic-provider",
        environment: "sandbox",
        identityRevision: 1,
      },
      reservations: await reserve("connection", operation),
    }),
    resolveAllocation: async (input, operation) => ({
      value: { ...input, eligibleQuantity: 2 },
      reservations: await reserve("stock-allocation", operation),
    }),
    authorizeResume: async () => ({ value: true, reservations: [] }),
  };
  return { authority, reserve, change, stores, sources };
}
