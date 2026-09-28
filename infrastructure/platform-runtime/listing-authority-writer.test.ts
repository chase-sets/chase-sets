import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createListingAuthorityParticipant } from "./listing-authority-participant";
import { createListingAuthorityFence } from "./listing-authority-fence";
import { createListingAuthorityWriter } from "./listing-authority-writer";

function fixture() {
  const { eventStore } = createInMemoryEventStore();
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic",
    audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
  };
  const source = createListingAuthorityParticipant({
    eventStore,
    participant: { owner: "inventory", purpose: "stock-allocation" },
    consumer: () => fence.forParticipant("inventory"),
    resources: () => ["synthetic-item"],
    validate: async (operation) => ({
      value: {},
      sourceRevisions: [{ resourceId: "synthetic-item", revision: "0" }],
      validBefore: operation.prepareBefore,
    }),
  });
  const { eventStore: consumerStore } = createInMemoryEventStore();
  const fence = createListingAuthorityFence({
    eventStore: consumerStore,
    owner: "marketplace",
    participants: [source],
  });
  const restart = () =>
    createListingAuthorityWriter({ eventStore, source, owner: "inventory", resources: async () => ["synthetic-item"] });
  const input = {
    streamId: "inventory.synthetic-item",
    expectedVersion: 0,
    context,
    events: [{ eventType: "inventory.synthetic.changed", payload: { quantity: 1 } }],
  } as const;
  return { source, eventStore, context, restart, input };
}

describe("source authority writer", () => {
  it("replays an exact committed mutation across restart without another business event", async () => {
    const f = fixture();
    const first = await f.restart().eventStore.appendToStream(f.input);
    expect(await f.restart().eventStore.appendToStream(f.input)).toEqual(first);
    expect(await f.eventStore.readStream({ streamId: f.input.streamId })).toHaveLength(1);
  });

  it("durably rejects a stale write without stranding closure or accepting its retry", async () => {
    const f = fixture();
    const writer = f.restart();
    await writer.eventStore.appendToStream(f.input);
    const stale = { ...f.input, events: [{ eventType: "inventory.synthetic.changed", payload: { quantity: 2 } }] };
    await expect(writer.eventStore.appendToStream(stale)).rejects.toMatchObject({ code: "concurrency_conflict" });
    await expect(f.restart().eventStore.appendToStream(stale)).rejects.toMatchObject({ code: "concurrency_conflict" });
    await writer.eventStore.appendToStream({ ...stale, expectedVersion: 1 });
    expect(await f.eventStore.readStream({ streamId: f.input.streamId })).toHaveLength(2);
  });

  it("does not allow an unversioned mutation to bypass current source checks", async () => {
    const f = fixture();
    await expect(f.restart().eventStore.appendToStream({ ...f.input, expectedVersion: "any" })).rejects.toThrow(
      "exact source versions",
    );
    expect(await f.eventStore.readAll()).toEqual([]);
  });
});
