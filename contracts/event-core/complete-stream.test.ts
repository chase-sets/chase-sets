import { describe, expect, it, vi } from "vitest";
import { EventStreamTooLongError, readCompleteStream } from "./complete-stream";
import { EVENT_STORE_READ_PAGE_SIZE_MAX } from "./storage";
import type { ReadStreamInput, StoredEvent } from "./storage";
import { createInMemoryEventStore } from "./test-support";
import type { EventStoreContext } from "./storage";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
  trace: {},
} as EventStoreContext;

const STREAM_ID = "commerce.order-ord_1";

function recordingReader(eventStore: ReturnType<typeof createInMemoryEventStore>["eventStore"]) {
  const calls: ReadStreamInput[] = [];
  return {
    calls,
    reader: {
      readStream: async (input: ReadStreamInput) => {
        calls.push(input);
        return eventStore.readStream(input);
      },
    },
  };
}

async function seedStream(
  eventStore: ReturnType<typeof createInMemoryEventStore>["eventStore"],
  eventCount: number,
): Promise<void> {
  await eventStore.appendToStream({
    streamId: STREAM_ID,
    expectedVersion: "no_stream",
    context,
    events: Array.from({ length: eventCount }, (_, index) => ({
      eventType: "commerce.order.line-added",
      payload: { sequence: index + 1 },
    })),
  });
}

describe("readCompleteStream", () => {
  it("returns a short history in one page", async () => {
    const { eventStore } = createInMemoryEventStore();
    await seedStream(eventStore, 3);
    const { calls, reader } = recordingReader(eventStore);

    const events = await readCompleteStream(reader, { streamId: STREAM_ID });

    expect(events.map((event) => event.streamVersion)).toEqual([1, 2, 3]);
    expect(calls).toEqual([{ streamId: STREAM_ID, fromVersion: 1, limit: EVENT_STORE_READ_PAGE_SIZE_MAX }]);
  });

  it("returns an empty history without inventing an event", async () => {
    const { eventStore } = createInMemoryEventStore();

    await expect(readCompleteStream(eventStore, { streamId: STREAM_ID })).resolves.toEqual([]);
  });

  it("stops at exactly one page when the history is exactly the page maximum", async () => {
    const { eventStore } = createInMemoryEventStore();
    await seedStream(eventStore, EVENT_STORE_READ_PAGE_SIZE_MAX);
    const { calls, reader } = recordingReader(eventStore);

    const events = await readCompleteStream(reader, { streamId: STREAM_ID });

    expect(events).toHaveLength(EVENT_STORE_READ_PAGE_SIZE_MAX);
    // A full first page proves nothing about the end of the stream, so the
    // reader must ask again -- the second read is what returns empty.
    expect(calls).toEqual([
      { streamId: STREAM_ID, fromVersion: 1, limit: EVENT_STORE_READ_PAGE_SIZE_MAX },
      {
        streamId: STREAM_ID,
        fromVersion: EVENT_STORE_READ_PAGE_SIZE_MAX + 1,
        limit: EVENT_STORE_READ_PAGE_SIZE_MAX,
      },
    ]);
  });

  it("returns the whole history one event past the page maximum, in order and without duplication", async () => {
    const { eventStore } = createInMemoryEventStore();
    await seedStream(eventStore, EVENT_STORE_READ_PAGE_SIZE_MAX + 1);
    const { calls, reader } = recordingReader(eventStore);

    const events = await readCompleteStream(reader, { streamId: STREAM_ID });

    expect(events.map((event) => event.streamVersion)).toEqual(
      Array.from({ length: EVENT_STORE_READ_PAGE_SIZE_MAX + 1 }, (_, index) => index + 1),
    );
    expect(new Set(events.map((event) => event.eventId)).size).toBe(EVENT_STORE_READ_PAGE_SIZE_MAX + 1);
    expect(calls[1]).toEqual({
      streamId: STREAM_ID,
      fromVersion: EVENT_STORE_READ_PAGE_SIZE_MAX + 1,
      limit: EVENT_STORE_READ_PAGE_SIZE_MAX,
    });
  });

  it("treats fromVersion as inclusive of the version it names", async () => {
    const { eventStore } = createInMemoryEventStore();
    await seedStream(eventStore, 5);

    const events = await readCompleteStream(eventStore, { streamId: STREAM_ID, fromVersion: 4 });

    expect(events.map((event) => event.streamVersion)).toEqual([4, 5]);
  });

  it("fails closed once a declared maxEvents bound is reached", async () => {
    const { eventStore } = createInMemoryEventStore();
    await seedStream(eventStore, EVENT_STORE_READ_PAGE_SIZE_MAX + 1);

    await expect(
      readCompleteStream(eventStore, { streamId: STREAM_ID, maxEvents: EVENT_STORE_READ_PAGE_SIZE_MAX }),
    ).rejects.toBeInstanceOf(EventStreamTooLongError);
  });

  it("does not apply a maxEvents bound to a history that fits inside one page", async () => {
    const { eventStore } = createInMemoryEventStore();
    await seedStream(eventStore, 10);

    await expect(readCompleteStream(eventStore, { streamId: STREAM_ID, maxEvents: 10 })).resolves.toHaveLength(10);
  });

  it("fails closed instead of duplicating when a store ignores fromVersion", async () => {
    const firstPage = Array.from(
      { length: EVENT_STORE_READ_PAGE_SIZE_MAX },
      (_, index) => ({ streamVersion: index + 1 }) as StoredEvent,
    );
    const reader = { readStream: vi.fn(async () => firstPage) };

    await expect(readCompleteStream(reader, { streamId: STREAM_ID })).rejects.toThrow(
      `returned stream version 1 for an inclusive read from version ${EVENT_STORE_READ_PAGE_SIZE_MAX + 1}`,
    );
    // Two reads, not an infinite loop: the second page is what proves the
    // store replayed a prefix it had already served.
    expect(reader.readStream).toHaveBeenCalledTimes(2);
  });

  it("fails closed instead of walking backwards on a descending page", async () => {
    const descendingPage = Array.from(
      { length: EVENT_STORE_READ_PAGE_SIZE_MAX },
      (_, index) => ({ streamVersion: EVENT_STORE_READ_PAGE_SIZE_MAX - index }) as StoredEvent,
    );
    const reader = { readStream: vi.fn(async () => descendingPage) };

    await expect(readCompleteStream(reader, { streamId: STREAM_ID })).rejects.toThrow(
      `returned a page ordered from version ${EVENT_STORE_READ_PAGE_SIZE_MAX} down to 1`,
    );
    expect(reader.readStream).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-positive fromVersion rather than reading from an undefined origin", async () => {
    const { eventStore } = createInMemoryEventStore();

    await expect(readCompleteStream(eventStore, { streamId: STREAM_ID, fromVersion: 0 })).rejects.toThrow(
      "fromVersion must be a positive integer",
    );
  });

  it("rejects a non-positive maxEvents rather than silently disabling the bound", async () => {
    const { eventStore } = createInMemoryEventStore();

    await expect(readCompleteStream(eventStore, { streamId: STREAM_ID, maxEvents: 0 })).rejects.toThrow(
      "maxEvents must be a positive integer",
    );
  });
});

describe("in-memory event store page cap", () => {
  it("enforces the same page maximum the Postgres store enforces", async () => {
    const { eventStore } = createInMemoryEventStore();
    await seedStream(eventStore, 3);

    await expect(
      eventStore.readStream({ streamId: STREAM_ID, limit: EVENT_STORE_READ_PAGE_SIZE_MAX + 1 }),
    ).rejects.toThrow(`Event store read limit must be an integer between 1 and ${EVENT_STORE_READ_PAGE_SIZE_MAX}`);
  });

  it("caps an omitted limit at the page maximum, so one read is never a whole history", async () => {
    const { eventStore } = createInMemoryEventStore();
    await seedStream(eventStore, EVENT_STORE_READ_PAGE_SIZE_MAX + 1);

    await expect(eventStore.readStream({ streamId: STREAM_ID })).resolves.toHaveLength(EVENT_STORE_READ_PAGE_SIZE_MAX);
  });
});
