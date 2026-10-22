import { describe, expect, it } from "vitest";
import type { EventStoreContext } from "./storage";
import { createInMemoryEventStore } from "./test-support";
import {
  assertOwnerStreamCommitParticipants,
  toOwnerStreamCommitParticipant,
  type OwnerStreamReservation,
} from "./owner-seal";

const context = {
  tenantId: "tnt_owner_seal",
  audit: { performedByUserId: "usr_owner_seal", forAccountId: "acc_owner_seal" },
} as unknown as EventStoreContext;

function reservation(streamId = "identity.account-acc_owner_seal"): OwnerStreamReservation {
  return {
    ownerContext: "identity",
    streamId,
    expectedVersion: 3,
    assertCurrent: async () => undefined,
    seal: { ownerContext: "identity", streamId, version: 3, context },
  };
}

describe("owner stream commit participation", () => {
  it("rejects duplicate consumed owner streams", async () => {
    const participant = toOwnerStreamCommitParticipant(reservation());
    await expect(assertOwnerStreamCommitParticipants([participant, participant], context)).rejects.toThrow(
      "Owner stream seal is duplicated",
    );
  });

  it("rejects duplicate participants without appending any business or request events", async () => {
    const memory = createInMemoryEventStore();
    const participant = toOwnerStreamCommitParticipant(reservation());
    await expect(
      memory.eventStore.appendToStreams!(
        ["marketplace.listing-lst_owner_seal", "marketplace.listing-request-owner_seal"].map((streamId) => ({
          streamId,
          expectedVersion: "no_stream" as const,
          context,
          events: [{ eventType: "marketplace.test.completed", payload: { schemaVersion: 1 } }],
        })),
        { commitParticipants: [participant, participant] },
      ),
    ).rejects.toThrow("Owner stream seal is duplicated");
    expect(memory.readAllEvents()).toHaveLength(0);
  });

  it("does not roll back an acknowledged append while a sealed append is preparing", async () => {
    const memory = createInMemoryEventStore();
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const participant = toOwnerStreamCommitParticipant({
      ...reservation("inventory.item-race"),
      assertCurrent: async () => {
        entered();
        await gate;
        throw new Error("owner promise was invalidated");
      },
    });

    const sealedAppend = memory.eventStore.appendToStreams!(
      [
        {
          streamId: "marketplace.listing-sealed",
          expectedVersion: "no_stream",
          context,
          events: [{ eventType: "marketplace.listing.created", payload: { schemaVersion: 1 } }],
        },
      ],
      { commitParticipants: [participant] },
    );
    await enteredPromise;
    await memory.eventStore.appendToStream({
      streamId: "marketplace.unrelated",
      expectedVersion: "no_stream",
      context,
      events: [{ eventType: "marketplace.test.committed", payload: { schemaVersion: 1 } }],
    });
    release();

    await expect(sealedAppend).rejects.toThrow("owner promise was invalidated");
    await expect(memory.eventStore.readStream({ streamId: "marketplace.unrelated" })).resolves.toHaveLength(1);
    await expect(memory.eventStore.readStream({ streamId: "marketplace.listing-sealed" })).resolves.toHaveLength(0);
  });
});
