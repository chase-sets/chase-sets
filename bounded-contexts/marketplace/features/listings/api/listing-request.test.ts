import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { toOwnerStreamCommitParticipant } from "@chase-sets/event-core/owner-seal";
import { createListingRequestExecutor, ListingRequestConflictError } from "./listing-request";

const context = {
  tenantId: "tnt_listing_request",
  audit: { performedByUserId: "usr_listing_request", forAccountId: "acc_listing_request" },
} as unknown as EventStoreContext;

const listingRequestReadContractSiteId =
  "bounded-contexts/marketplace/features/listings/api/listing-request.ts#readStream#1";

describe("Listing request owner commit participation", () => {
  it("rejects an owner invalidated at the Marketplace append boundary and permits the newer command", async () => {
    const memory = createInMemoryEventStore();
    let ownerCurrent = true;
    let invalidateOnAppend = true;
    const participant = () =>
      toOwnerStreamCommitParticipant({
        ownerContext: "identity",
        streamId: "identity.account-acc_listing_request",
        expectedVersion: 3,
        assertCurrent: async () => {
          if (!ownerCurrent) throw new Error("Identity account authority changed.");
        },
        seal: {
          ownerContext: "identity",
          streamId: "identity.account-acc_listing_request",
          version: 3,
          context,
        },
      });
    const append = memory.eventStore.appendToStreams!;
    const eventStore: EventStore = {
      ...memory.eventStore,
      appendToStreams: async (inputs, options) => {
        if (invalidateOnAppend) ownerCurrent = false;
        return append(inputs, options);
      },
    };
    const execute = createListingRequestExecutor(eventStore);
    const command = { kind: "channel-activation", listingId: "lst_listing_request" };

    await expect(
      execute({
        accountId: "acc_listing_request",
        idempotencyKey: "owner-interleave",
        command,
        context,
        prepare: async () => ({ result: { ok: true }, appends: [], commitParticipants: [participant()] }),
      }),
    ).rejects.toThrow("Identity account authority changed");
    expect(memory.readAllEvents()).toHaveLength(0);

    ownerCurrent = true;
    invalidateOnAppend = false;
    await expect(
      execute({
        accountId: "acc_listing_request",
        idempotencyKey: "owner-interleave",
        command,
        context,
        prepare: async () => ({ result: { ok: true }, appends: [], commitParticipants: [participant()] }),
      }),
    ).resolves.toEqual({ ok: true });
    expect(memory.readAllEvents()).toHaveLength(1);
  });

  it(`${listingRequestReadContractSiteId} rejects duplicate history instead of replaying the first event`, async () => {
    const memory = createInMemoryEventStore();
    const participant = toOwnerStreamCommitParticipant({
      ownerContext: "identity",
      streamId: "identity.account-acc_listing_request",
      expectedVersion: 3,
      assertCurrent: async () => undefined,
      seal: {
        ownerContext: "identity",
        streamId: "identity.account-acc_listing_request",
        version: 3,
        context,
      },
    });
    const execute = createListingRequestExecutor(memory.eventStore);
    const input = {
      accountId: "acc_listing_request",
      idempotencyKey: "duplicate-history",
      command: { kind: "channel-activation", listingId: "lst_listing_request" },
      context,
      prepare: async () => ({ result: { ok: true }, appends: [], commitParticipants: [participant] }),
    };
    await expect(execute(input)).resolves.toEqual({ ok: true });
    await expect(execute(input)).resolves.toEqual({ ok: true });
    const completed = memory.readAllEvents()[0]!;
    await memory.eventStore.appendToStream({
      streamId: completed.streamId,
      expectedVersion: 1,
      context,
      events: [{ eventType: completed.eventType, payload: completed.payload }],
    });

    await expect(execute(input)).rejects.toBeInstanceOf(ListingRequestConflictError);
    expect(memory.readAllEvents()).toHaveLength(2);
  });
});
