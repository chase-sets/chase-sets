import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createListingAuthorityParticipant } from "./listing-authority-participant";
import { createListingAuthorityFence, type ListingAuthorityOperationInput } from "./listing-authority-fence";
import { createListingAuthorityWriter } from "./listing-authority-writer";
import { createListingAuthorityRecovery } from "./listing-authority-recovery";

function fixture(mutatingPreparation = false) {
  const memory = createInMemoryEventStore();
  const consumerMemory = createInMemoryEventStore();
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic",
    audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
  };
  let now = new Date();
  let unknown = false;
  let failValidation = mutatingPreparation;
  let validations = 0;
  const consumer = () => ({
    inspect: (operation: Parameters<typeof fence.inspect>[0]) =>
      unknown ? Promise.resolve({ status: "unknown" as const }) : fence.inspect(operation),
    invalidate: (operation: Parameters<typeof fence.abort>[0], reason: string) => {
      if (unknown) throw new Error("synthetic consumer outage");
      return fence.forParticipant("inventory").invalidate(operation, reason);
    },
  });
  const source = createListingAuthorityParticipant({
    eventStore: memory.eventStore,
    participant: { owner: "inventory", purpose: "stock-allocation" },
    consumer,
    resources: (operation) => [operation.listingId],
    validate: async (operation) => {
      if (++validations === 2 && failValidation) {
        failValidation = false;
        throw new Error("synthetic crash after preparation closure");
      }
      return {
        value: {},
        sourceRevisions: [{ resourceId: "synthetic-stock", revision: "0" }],
        validBefore: operation.prepareBefore,
        ...(mutatingPreparation
          ? {
              localAppends: [
                {
                  streamId: "inventory.synthetic-hold",
                  expectedVersion: 0,
                  context,
                  events: [{ eventType: "inventory.synthetic-hold.placed", payload: {} }],
                },
              ],
            }
          : {}),
      };
    },
  });
  const fence = createListingAuthorityFence({
    eventStore: consumerMemory.eventStore,
    owner: "ordering",
    participants: [source],
    now: () => now,
  });
  const writer = createListingAuthorityWriter({
    eventStore: memory.eventStore,
    owner: "inventory",
    source,
    resources: async () => ["lst_synthetic"],
  });
  const db: PgQueryable = {
    async query<Row>(_sql: string, values?: readonly unknown[]) {
      const terminalTypes = values![3] as string[];
      const rows = [...memory.streams]
        .flatMap(([stream_id, history]) =>
          history
            .filter(
              (event) =>
                ((event.streamVersion === 1 &&
                  (stream_id.includes("-reservation-") || stream_id.includes("-mutation-"))) ||
                  (stream_id.includes("-write-") && event.eventType === values![6])) &&
                BigInt(event.globalPosition) > BigInt(String(values![0])) &&
                !history.some(
                  (later) => later.streamVersion > event.streamVersion && terminalTypes.includes(later.eventType),
                ),
            )
            .map((event) => ({
              stream_id,
              global_position: event.globalPosition,
              tenant_id: event.tenantId,
              payload: event.payload,
            })),
        )
        .sort((a, b) => Number(BigInt(a.global_position) - BigInt(b.global_position)))
        .slice(0, Number(values![4]));
      return { rows: rows as Row[] };
    },
  };
  const restart = () =>
    createListingAuthorityRecovery({
      db,
      owner: "inventory",
      sources: [source],
      consumer,
      resume: writer.resume,
      resumeWrite: writer.resumeWrite,
      now: () => now,
    });
  const input: ListingAuthorityOperationInput = {
    tenantId: context.tenantId,
    accountId: context.audit.forAccountId,
    actor: { kind: "user", userId: context.audit.performedByUserId },
    committingOwner: "ordering",
    kind: "native-commitment",
    requestId: "synthetic-recovery",
    command: {},
    listingId: "lst_synthetic",
    subject: {
      inventoryItemId: "inv_synthetic",
      catalogItemId: "cat_synthetic",
      productId: "cat_synthetic::",
      selectedOptions: [],
      quantity: 1,
      pair: { amount: "1.00", currencyCode: "USD" },
      allocationRevision: null,
      commitmentSourceId: "ord_synthetic",
    },
    target: { kind: "native-marketplace" },
    expectedListingRevision: 1,
    expectedTargetRevision: 1,
    expectedVisibilityRevision: 1,
    expectedPublicationRevision: 1,
    participants: [source.participant],
  };
  return {
    memory,
    consumerMemory,
    context,
    source,
    fence,
    writer,
    input,
    restart,
    setUnknown: (value: boolean) => {
      unknown = value;
    },
    expire: () => {
      now = new Date(now.getTime() + 70_000);
    },
  };
}

describe("owner Listing authority recovery", () => {
  it("settles a committed promise after the consumer lost its acknowledgement", async () => {
    const f = fixture();
    const operation = await f.fence.open(f.input, f.context);
    const grant = await f.source.prepare(operation, f.context);
    await f.consumerMemory.eventStore.appendToStreams!([
      await f.fence.prepareCommit(operation, [grant], { committed: true }),
    ]);
    expect((await f.restart()()).outcomes).toMatchObject([{ status: "settled" }]);
    expect((await f.source.inspect(operation))?.status).toBe("consumed");
    expect((await f.restart()()).outcomes).toEqual([]);
  });

  it("never releases an unknown or live pending consumer, then aborts an expired promise through its fence", async () => {
    const f = fixture();
    const operation = await f.fence.open(f.input, f.context);
    await f.source.prepare(operation, f.context);
    expect((await f.restart()()).outcomes).toMatchObject([{ status: "pending" }]);
    f.setUnknown(true);
    f.expire();
    expect((await f.restart()()).outcomes).toMatchObject([{ status: "blocked" }]);
    expect((await f.source.inspect(operation))?.status).toBe("reserved");
    f.setUnknown(false);
    expect((await f.restart()()).outcomes).toMatchObject([{ status: "settled" }]);
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
    expect((await f.source.inspect(operation))?.status).toBe("released");
  });

  it("resumes an interrupted writer from its original durable intent", async () => {
    const f = fixture();
    const operation = await f.fence.open(f.input, f.context);
    await f.source.prepare(operation, f.context);
    f.setUnknown(true);
    await expect(
      f.writer.eventStore.appendToStream({
        streamId: "inventory.synthetic-stock",
        expectedVersion: 0,
        context: f.context,
        events: [{ eventType: "inventory.synthetic-stock.changed", payload: { quantity: 2 } }],
      }),
    ).rejects.toThrow("synthetic consumer outage");
    f.setUnknown(false);
    const result = await f.restart()();
    expect(result.outcomes.map((entry) => entry.status)).toEqual(["pending", "resumed", "resumed"]);
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
    expect(await f.memory.eventStore.readStream({ streamId: "inventory.synthetic-stock" })).toHaveLength(1);
  });

  it("discovers a writer crash before resource closure and resumes its exact intent", async () => {
    const f = fixture();
    const broken = createListingAuthorityWriter({
      eventStore: f.memory.eventStore,
      owner: "inventory",
      source: {
        ...f.source,
        mutate: async () => {
          throw new Error("synthetic crash before closure");
        },
      },
      resources: async () => ["lst_synthetic"],
    });
    await expect(
      broken.eventStore.appendToStream({
        streamId: "inventory.synthetic-stock",
        expectedVersion: 0,
        context: f.context,
        events: [{ eventType: "inventory.synthetic-stock.changed", payload: { quantity: 2 } }],
      }),
    ).rejects.toThrow("before closure");
    expect((await f.restart()()).outcomes).toMatchObject([{ status: "resumed" }]);
    expect(await f.memory.eventStore.readStream({ streamId: "inventory.synthetic-stock" })).toHaveLength(1);
    expect((await f.restart()()).outcomes).toEqual([]);
  });

  it("clears an interrupted mutating preparation only after its permanent abort", async () => {
    const f = fixture(true);
    const operation = await f.fence.open(f.input, f.context);
    await expect(f.source.prepare(operation, f.context)).rejects.toThrow("synthetic crash after preparation closure");
    f.expire();
    expect((await f.restart()()).outcomes).toMatchObject([{ status: "resumed" }]);
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
    expect(await f.memory.eventStore.readStream({ streamId: "inventory.synthetic-hold" })).toHaveLength(0);
    expect((await f.restart()()).outcomes).toEqual([]);
  });

  it("bounds pages without dropping retained pending reservations", async () => {
    const f = fixture();
    for (const id of ["one", "two"])
      await f.source.prepare(await f.fence.open({ ...f.input, requestId: id, listingId: id }, f.context), f.context);
    const first = await f.restart()({ limit: 1 });
    expect(first.outcomes).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const next = await f.restart()({ limit: 1, after: first.nextCursor! });
    expect(next.outcomes).toHaveLength(1);
    expect(next.outcomes[0]!.streamId).not.toBe(first.outcomes[0]!.streamId);
    await expect(f.restart()({ limit: 101 })).rejects.toThrow("bounded");
  });
});
