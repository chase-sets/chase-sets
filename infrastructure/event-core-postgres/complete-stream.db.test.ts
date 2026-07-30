import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventStreamTooLongError, readCompleteStream } from "@chase-sets/event-core/complete-stream";
import {
  EVENT_STORE_READ_PAGE_SIZE_MAX,
  type EventStoreContext,
  type ReadStreamInput,
  type StoredEvent,
} from "@chase-sets/event-core/storage";
import { createPostgresEventStore } from "./event-store";
import { createIsolatedPostgresTestSchema, type IsolatedPostgresTestSchema } from "./postgres-db-test-support";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

const STREAM_ID = "commerce.order-ord_issue_6298";

const context: EventStoreContext = {
  tenantId: "tnt_complete" as never,
  audit: {
    performedByUserId: "usr_system" as never,
    forAccountId: "acc_system" as never,
  },
};

describeDb("complete event streams against real PostgreSQL", () => {
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

  async function appendEvents(firstSequence: number, lastSequence: number): Promise<void> {
    const store = createPostgresEventStore({ pool: schema.pool });
    for (let first = firstSequence; first <= lastSequence; first += EVENT_STORE_READ_PAGE_SIZE_MAX) {
      const last = Math.min(first + EVENT_STORE_READ_PAGE_SIZE_MAX - 1, lastSequence);
      await store.appendToStream({
        streamId: STREAM_ID,
        expectedVersion: first === 1 ? "no_stream" : first - 1,
        context,
        events: Array.from({ length: last - first + 1 }, (_, index) => {
          const sequence = first + index;
          return {
            eventId: `evt_issue_6298_${sequence}` as never,
            eventType: "commerce.order.line-added",
            payload: { sequence },
          };
        }),
      });
    }
  }

  function recordingReader() {
    const store = createPostgresEventStore({ pool: schema.pool });
    const calls: ReadStreamInput[] = [];
    return {
      calls,
      store,
      reader: {
        readStream: async (input: ReadStreamInput) => {
          calls.push(input);
          return store.readStream(input);
        },
      },
    };
  }

  function assertExactHistory(events: readonly StoredEvent[], firstVersion: number, lastVersion: number): void {
    const expected = Array.from({ length: lastVersion - firstVersion + 1 }, (_, index) => firstVersion + index);
    expect(events.map((event) => event.streamVersion)).toEqual(expected);
    expect(events.map((event) => event.eventId)).toEqual(expected.map((version) => `evt_issue_6298_${version}`));
    expect(events.map((event) => event.payload)).toEqual(expected.map((sequence) => ({ sequence })));
  }

  it("issue-6298-acceptance-control returns complete 500- and 501-event histories with exact sequences", async () => {
    await appendEvents(1, 500);
    const exactPage = recordingReader();
    const fiveHundred = await readCompleteStream(exactPage.reader, { streamId: STREAM_ID, maxEvents: 500 });
    assertExactHistory(fiveHundred, 1, 500);
    expect(exactPage.calls.map((call) => call.fromVersion)).toEqual([1, 501]);

    await schema.reset();
    await appendEvents(1, 501);
    const overPage = recordingReader();
    const cappedPredecessor = await overPage.store.readStream({ streamId: STREAM_ID });
    expect(cappedPredecessor).toHaveLength(500);
    assertExactHistory(await readCompleteStream(overPage.reader, { streamId: STREAM_ID }), 1, 501);
    await expect(readCompleteStream(overPage.store, { streamId: STREAM_ID, maxEvents: 500 })).rejects.toBeInstanceOf(
      EventStreamTooLongError,
    );
  });

  it("returns a complete ordered three-page history", async () => {
    await appendEvents(1, EVENT_STORE_READ_PAGE_SIZE_MAX * 2 + 1);
    const { calls, reader } = recordingReader();

    assertExactHistory(
      await readCompleteStream(reader, { streamId: STREAM_ID }),
      1,
      EVENT_STORE_READ_PAGE_SIZE_MAX * 2 + 1,
    );
    expect(calls.map((call) => call.fromVersion)).toEqual([1, 501, 1001]);
  });

  it("respects an inclusive non-one cursor across a page boundary", async () => {
    await appendEvents(1, 537);
    const { calls, reader } = recordingReader();

    assertExactHistory(await readCompleteStream(reader, { streamId: STREAM_ID, fromVersion: 37 }), 37, 537);
    expect(calls.map((call) => call.fromVersion)).toEqual([37, 537]);
  });

  it("includes a concurrent append visible before the terminal read", async () => {
    await appendEvents(1, 500);
    const store = createPostgresEventStore({ pool: schema.pool });
    const calls: ReadStreamInput[] = [];

    const events = await readCompleteStream(
      {
        readStream: async (input) => {
          calls.push(input);
          if (input.fromVersion === 501) {
            await appendEvents(501, 501);
          }
          return store.readStream(input);
        },
      },
      { streamId: STREAM_ID },
    );

    assertExactHistory(events, 1, 501);
    expect(calls.map((call) => call.fromVersion)).toEqual([1, 501]);
  });

  it("excludes a concurrent append visible only after the terminal read", async () => {
    await appendEvents(1, 500);
    const store = createPostgresEventStore({ pool: schema.pool });

    const events = await readCompleteStream(
      {
        readStream: async (input) => {
          const page = await store.readStream(input);
          if (input.fromVersion === 501) {
            await appendEvents(501, 501);
          }
          return page;
        },
      },
      { streamId: STREAM_ID },
    );

    assertExactHistory(events, 1, 500);
    assertExactHistory(await store.readStream({ streamId: STREAM_ID, fromVersion: 501 }), 501, 501);
    await expect(
      store.appendToStream({
        streamId: STREAM_ID,
        expectedVersion: events.at(-1)!.streamVersion,
        context,
        events: [
          {
            eventId: "evt_issue_6298_502" as never,
            eventType: "commerce.order.line-added",
            payload: { sequence: 502 },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "concurrency_conflict",
      details: { expectedVersion: 500, currentVersion: 501 },
    });
  });
});
