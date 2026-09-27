import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createListingRequestExecutor, ListingRequestConflictError } from "./listing-request";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { forAccountId: "acc_test" as never, performedByUserId: "usr_test" as never },
};

function fixture() {
  const { eventStore } = createInMemoryEventStore();
  const execute = createListingRequestExecutor(eventStore);
  const input = {
    accountId: "acc_test",
    idempotencyKey: "accept-1",
    command: {
      listingId: "lst_test",
      target: { kind: "native-marketplace" },
      priceAmount: "10.00",
      priceCurrencyCode: "USD",
    },
    context,
    prepare: async () => ({
      result: { listingId: "lst_test", version: 1 },
      appends: [
        {
          streamId: "marketplace.listing-lst_test",
          expectedVersion: 0,
          context,
          events: [
            {
              eventType: "marketplace.listing.price-updated",
              payload: { priceAmount: "10.00", priceCurrencyCode: "USD" },
            },
          ],
        },
      ],
    }),
  };
  return { eventStore, execute, input };
}

describe("atomic listing request retry", () => {
  it("retains the original committed source checkpoint on a durable replay", async () => {
    const { execute, input, eventStore } = fixture();
    await execute(input);
    const result = await runWithEventCommitMetadata(async () => {
      await execute(input);
      return getEventCommitMetadata();
    });
    expect(result.sources).toMatchObject([{ sourceContextName: "marketplace", maxGlobalPosition: "2" }]);
    expect(await eventStore.readAll()).toHaveLength(2);
  });
  it("replays an identical request that commits while this request is still preparing", async () => {
    const { execute, input, eventStore } = fixture();
    const result = await execute({
      ...input,
      prepare: async () => {
        await execute(input);
        throw new Error("Listing revision changed.");
      },
    });
    expect(result).toEqual({ listingId: "lst_test", version: 1 });
    expect(await eventStore.readAll()).toHaveLength(2);
  });
  it("returns the original result for concurrent identical accepts without duplicate events", async () => {
    const { execute, input, eventStore } = fixture();
    expect(await Promise.all([execute(input), execute(input)])).toEqual([
      { listingId: "lst_test", version: 1 },
      { listingId: "lst_test", version: 1 },
    ]);
    expect(await eventStore.readAll()).toHaveLength(2);
  });

  it.each([
    { priceCurrencyCode: "CAD" },
    { target: { kind: "channel-connection", connectionId: "con_test" } },
    { expectedTargetPriceRevision: 2 },
    { decision: { evaluationRevision: "new" } },
  ])("rejects changed complete-command authority on the same key: %j", async (change) => {
    const { execute, input, eventStore } = fixture();
    await execute(input);
    await expect(execute({ ...input, command: { ...input.command, ...change } })).rejects.toBeInstanceOf(
      ListingRequestConflictError,
    );
    expect(await eventStore.readAll()).toHaveLength(2);
  });

  it("rolls back the request result when an authority version guard changes", async () => {
    const { execute, input, eventStore } = fixture();
    await eventStore.appendToStream({
      streamId: "authority",
      expectedVersion: 0,
      context,
      events: [{ eventType: "authority.changed", payload: {} }],
    });
    await expect(
      execute({
        ...input,
        prepare: async () => {
          const prepared = await input.prepare();
          return {
            ...prepared,
            appends: [...prepared.appends, { streamId: "authority", expectedVersion: 0, context, events: [] }],
          };
        },
      }),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect(await eventStore.readAll()).toHaveLength(1);
    expect(await execute(input)).toEqual({ listingId: "lst_test", version: 1 });
  });

  it("rejects a foreign context before preparing or appending", async () => {
    const { execute, input, eventStore } = fixture();
    await expect(execute({ ...input, accountId: "acc_foreign" })).rejects.toThrow("authority mismatch");
    expect(await eventStore.readAll()).toHaveLength(0);
  });
});
