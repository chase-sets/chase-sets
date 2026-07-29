import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { EVENT_STORE_READ_PAGE_SIZE_MAX } from "@chase-sets/event-core/storage";
import type { EventStoreContext, ReadStreamInput, StoredEvent } from "@chase-sets/event-core/storage";
import { createPostgresEventStore } from "./event-store";
import { createIsolatedPostgresTestSchema, type IsolatedPostgresTestSchema } from "./postgres-db-test-support";

/**
 * The 500/501 boundary controls for #6277. These run against real Postgres on
 * purpose: the truncation that shipped in PR #6272 was invisible to an
 * 86-test suite built on fakes, and only a real `LIMIT 500` produced the
 * 500-of-501 read that broke terminal and day-after registration histories.
 */
const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

const STREAM_ID = "commerce.order-ord_complete";

describeDb("complete stream rehydration against real Postgres", () => {
  let schema: IsolatedPostgresTestSchema;

  beforeAll(async () => {
    schema = await createIsolatedPostgresTestSchema(adminDatabaseUrl!, "complete_stream");
  });

  beforeEach(async () => {
    await schema.reset();
  });

  afterAll(async () => {
    await schema?.close();
  });

  async function seedStream(eventCount: number): Promise<void> {
    const store = createPostgresEventStore({ pool: schema.pool });
    // Chunked at the page maximum so the append path itself stays inside the
    // parameter budget while the resulting history crosses the read boundary.
    for (let appended = 0; appended < eventCount; appended += EVENT_STORE_READ_PAGE_SIZE_MAX) {
      const chunk = Math.min(EVENT_STORE_READ_PAGE_SIZE_MAX, eventCount - appended);
      await store.appendToStream({
        streamId: STREAM_ID,
        expectedVersion: appended === 0 ? "no_stream" : appended,
        context: eventContext(),
        events: Array.from({ length: chunk }, (_, index) => ({
          eventType: "commerce.order.line-added",
          payload: { sequence: appended + index + 1 },
        })),
      });
    }
  }

  function recordingStore() {
    const store = createPostgresEventStore({ pool: schema.pool });
    const calls: ReadStreamInput[] = [];
    return {
      calls,
      reader: {
        readStream: async (input: ReadStreamInput) => {
          calls.push(input);
          return store.readStream(input);
        },
      },
      store,
    };
  }

  function assertContiguousHistory(events: readonly StoredEvent[], eventCount: number): void {
    expect(events).toHaveLength(eventCount);
    // Ordering, no omission, no duplication -- all three from one assertion on
    // the version sequence, plus a distinct-id count that a repeated page
    // would fail even if the versions happened to line up.
    expect(events.map((event) => event.streamVersion)).toEqual(
      Array.from({ length: eventCount }, (_, index) => index + 1),
    );
    expect(new Set(events.map((event) => event.eventId)).size).toBe(eventCount);
    expect(events.map((event) => (event.payload as { sequence: number }).sequence)).toEqual(
      Array.from({ length: eventCount }, (_, index) => index + 1),
    );
  }

  it("returns a 500-event history complete and ordered", async () => {
    await seedStream(EVENT_STORE_READ_PAGE_SIZE_MAX);
    const { calls, reader } = recordingStore();

    assertContiguousHistory(await readCompleteStream(reader, { streamId: STREAM_ID }), EVENT_STORE_READ_PAGE_SIZE_MAX);
    expect(calls).toHaveLength(2);
  });

  it("returns a 501-event history complete and ordered, which one capped read cannot", async () => {
    const eventCount = EVENT_STORE_READ_PAGE_SIZE_MAX + 1;
    await seedStream(eventCount);
    const { calls, reader, store } = recordingStore();

    // The defect, reproduced first: one default-capped read of a 501-event
    // stream returns 500 events and looks like a complete history.
    const cappedRead = await store.readStream({ streamId: STREAM_ID });
    expect(cappedRead).toHaveLength(EVENT_STORE_READ_PAGE_SIZE_MAX);
    expect(cappedRead[cappedRead.length - 1].streamVersion).toBe(EVENT_STORE_READ_PAGE_SIZE_MAX);

    assertContiguousHistory(await readCompleteStream(reader, { streamId: STREAM_ID }), eventCount);
    // Next-page ordering: the second read starts at the version immediately
    // after the last one the first page returned, inclusive.
    expect(calls).toEqual([
      { streamId: STREAM_ID, fromVersion: 1, limit: EVENT_STORE_READ_PAGE_SIZE_MAX },
      { streamId: STREAM_ID, fromVersion: eventCount, limit: EVENT_STORE_READ_PAGE_SIZE_MAX },
    ]);
  });

  it("returns a multi-page history complete and ordered across three pages", async () => {
    const eventCount = EVENT_STORE_READ_PAGE_SIZE_MAX * 2 + 1;
    await seedStream(eventCount);
    const { calls, reader } = recordingStore();

    assertContiguousHistory(await readCompleteStream(reader, { streamId: STREAM_ID }), eventCount);
    expect(calls.map((call) => call.fromVersion)).toEqual([
      1,
      EVENT_STORE_READ_PAGE_SIZE_MAX + 1,
      EVENT_STORE_READ_PAGE_SIZE_MAX * 2 + 1,
    ]);
  });

  it("reads inclusively from the version it is given, across the page boundary", async () => {
    const eventCount = EVENT_STORE_READ_PAGE_SIZE_MAX + 1;
    await seedStream(eventCount);
    const store = createPostgresEventStore({ pool: schema.pool });

    const tail = await readCompleteStream(store, {
      streamId: STREAM_ID,
      fromVersion: EVENT_STORE_READ_PAGE_SIZE_MAX,
    });

    expect(tail.map((event) => event.streamVersion)).toEqual([
      EVENT_STORE_READ_PAGE_SIZE_MAX,
      EVENT_STORE_READ_PAGE_SIZE_MAX + 1,
    ]);
  });

  it("rejects a page larger than the enforced maximum instead of shrinking it silently", async () => {
    await seedStream(1);
    const store = createPostgresEventStore({ pool: schema.pool });

    await expect(store.readStream({ streamId: STREAM_ID, limit: EVENT_STORE_READ_PAGE_SIZE_MAX + 1 })).rejects.toThrow(
      `Event store read limit must be an integer between 1 and ${EVENT_STORE_READ_PAGE_SIZE_MAX}`,
    );
  });
});

function eventContext(): EventStoreContext {
  return {
    tenantId: "tnt_complete" as EventStoreContext["tenantId"],
    audit: {
      performedByUserId: "usr_system" as EventStoreContext["audit"]["performedByUserId"],
      forAccountId: "acc_system" as EventStoreContext["audit"]["forAccountId"],
    },
  };
}
