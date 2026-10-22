import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { toOwnerStreamCommitParticipant } from "@chase-sets/event-core/owner-seal";
import { createListingRequestExecutor } from "./listing-request";

const context = {
  tenantId: "tnt_listing_request",
  audit: { performedByUserId: "usr_listing_request", forAccountId: "acc_listing_request" },
} as unknown as EventStoreContext;

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
});
