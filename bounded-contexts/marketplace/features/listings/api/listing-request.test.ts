import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createListingRequestExecutor,
  ListingRequestConflictError,
  prepareListingRequest,
  listingRequestStreamId,
} from "./listing-request";
import { createListingAuthorityFence } from "@chase-sets/platform-runtime/listing-authority-fence";
import { createListingAuthorityParticipant } from "@chase-sets/platform-runtime/listing-authority-participant";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { forAccountId: "acc_test" as never, performedByUserId: "usr_test" as never },
};

function fixture() {
  const memory = createInMemoryEventStore();
  const { eventStore } = memory;
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
  return { eventStore, execute, input, memory };
}

async function authorityFixture() {
  const f = fixture();
  const sourceMemory = createInMemoryEventStore();
  const source = createListingAuthorityParticipant({
    eventStore: sourceMemory.eventStore,
    participant: { owner: "catalog", purpose: "product-measures" },
    consumer: () => fence.forParticipant("catalog"),
    resources: () => ["synthetic-product"],
    validate: async (operation) => ({
      value: {},
      sourceRevisions: [{ resourceId: "synthetic-product", revision: "0" }],
      validBefore: operation.prepareBefore,
    }),
  });
  const fence = createListingAuthorityFence({ eventStore: f.eventStore, owner: "marketplace", participants: [source] });
  const operation = await fence.open(
    {
      tenantId: context.tenantId,
      accountId: context.audit.forAccountId,
      actor: { kind: "user", userId: context.audit.performedByUserId },
      committingOwner: "marketplace",
      kind: "native-visibility",
      requestId: f.input.idempotencyKey,
      command: f.input.command,
      listingId: "lst_test",
      target: { kind: "native-marketplace" },
      subject: {
        inventoryItemId: "inv_synthetic",
        catalogItemId: "cat_synthetic",
        productId: "cat_synthetic::",
        selectedOptions: [],
        quantity: 1,
        pair: { amount: "10.00", currencyCode: "USD" },
        allocationRevision: null,
        commitmentSourceId: null,
      },
      expectedListingRevision: 0,
      expectedTargetRevision: null,
      expectedVisibilityRevision: null,
      expectedPublicationRevision: null,
      participants: [source.participant],
    },
    context,
  );
  const input = {
    ...f.input,
    authority: { fence, operation },
    prepare: async () => ({
      ...(await f.input.prepare()),
      reservations: [await source.prepare(operation, context)],
    }),
  };
  const prepared = await prepareListingRequest(f.eventStore, input);
  return {
    ...f,
    source,
    sourceMemory,
    fence,
    operation,
    input,
    prepared,
    invalidate: () =>
      source.mutate({
        resources: ["synthetic-product"],
        mutationId: "synthetic-request-revoke",
        command: { revoke: true },
        context,
        prepare: async () => [
          {
            streamId: "catalog.synthetic-request-source",
            expectedVersion: 0,
            context,
            events: [{ eventType: "catalog.synthetic-revoked", payload: {} }],
          },
        ],
      }),
  };
}

describe("request result history cannot reopen authority", () => {
  for (const damage of ["operation-loss", "operation-witness-pair", "resource-witness-pair"] as const)
    it(`fabricated request success with ${damage} never substitutes for the exact terminal`, async () => {
      const f = await authorityFixture();
      const streamId = listingRequestStreamId(f.input.accountId, f.input.idempotencyKey);
      await f.eventStore.appendToStream(f.prepared.appends.find((append) => append.streamId === streamId)!);
      const operationStream = `marketplace.listing-authority-operation-${f.operation.operationId}`;
      if (damage === "operation-loss") f.memory.streams.delete(operationStream);
      else {
        const histories = damage === "operation-witness-pair" ? f.memory.streams : f.sourceMemory.streams;
        const canonical =
          damage === "operation-witness-pair"
            ? operationStream
            : [...histories.keys()].filter((id) => id.startsWith("catalog.listing-authority-resource-"))[0]!;
        const witnesses =
          damage === "operation-witness-pair"
            ? [
                canonical.replace("-operation-", "-integrity-operation-"),
                canonical.replace("-operation-", "-registration-operation-"),
              ]
            : [
                canonical.replace("-resource-", "-integrity-"),
                canonical.replace("-resource-", "-registration-resource-"),
              ];
        for (const witness of witnesses)
          histories.set(
            witness,
            histories.get(witness)!.map((event) => ({
              ...event,
              payload: {
                ...event.payload,
                [damage === "operation-witness-pair" ? "eventHash" : "stateHash"]: "synthetic-false-success",
              },
            })),
          );
      }
      await expect(f.execute(f.input)).rejects.toThrow();
      expect(await f.eventStore.readStream({ streamId: "marketplace.listing-lst_test" })).toHaveLength(0);
      expect(await f.sourceMemory.eventStore.readStream({ streamId: "catalog.synthetic-request-source" })).toHaveLength(
        0,
      );
      expect(
        [...f.sourceMemory.streams.values()].flat().filter((event) => event.eventType.endsWith(".settled")),
      ).toHaveLength(0);
    });
  it("a recreated success result cannot release a pending source promise", async () => {
    const f = await authorityFixture();
    const streamId = listingRequestStreamId(f.input.accountId, f.input.idempotencyKey);
    const forged = f.prepared.appends.find((append) => append.streamId === streamId)!;
    await f.eventStore.appendToStream(forged);
    await expect(f.execute(f.input)).rejects.toThrow("matching committed authority terminal");
    expect((await f.source.inspect(f.operation))?.status).toBe("reserved");
    expect((await f.fence.inspect(f.operation)).status).toBe("pending");
    expect(await f.eventStore.readStream({ streamId: "marketplace.listing-lst_test" })).toHaveLength(0);
  });

  for (const fault of ["loss", "truncation", "recreation"] as const)
    for (const pairedOperationLoss of [false, true])
      it(`${fault} request result${pairedOperationLoss ? " plus consumer history" : ""} cannot repeat a prior effect`, async () => {
        const f = await authorityFixture();
        await f.eventStore.appendToStreams!(f.prepared.appends);
        await f.invalidate();
        const streamId = listingRequestStreamId(f.input.accountId, f.input.idempotencyKey);
        const events = f.memory.streams.get(streamId)!;
        if (fault === "loss") f.memory.streams.delete(streamId);
        else if (fault === "truncation") f.memory.streams.set(streamId, []);
        else
          f.memory.streams.set(streamId, [
            {
              ...events[0]!,
              eventId: "evt_synthetic-request-recreated",
              payload: { ...events[0]!.payload, result: { listingId: "lst_test", version: 999 } },
            },
          ]);
        if (pairedOperationLoss)
          f.memory.streams.delete(`marketplace.listing-authority-operation-${f.operation.operationId}`);
        await expect(f.execute(f.input)).rejects.toThrow();
        await expect(f.eventStore.appendToStreams!(f.prepared.appends)).rejects.toThrow();
        expect(await f.eventStore.readStream({ streamId: "marketplace.listing-lst_test" })).toHaveLength(1);
        expect(
          await f.sourceMemory.eventStore.readStream({ streamId: "catalog.synthetic-request-source" }),
        ).toHaveLength(1);
        expect((await f.source.inspect(f.operation))?.status).toBe("consumed");
      });
});

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
