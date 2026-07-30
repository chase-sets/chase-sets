import { describe, expect, it, vi } from "vitest";
import { EventStreamTooLongError, readCompleteStream, type CompleteStreamReader } from "./complete-stream";
import { EVENT_STORE_READ_PAGE_SIZE_MAX, type ReadStreamInput, type StoredEvent } from "./storage";

const STREAM_ID = "commerce.order-ord_complete";

type CompleteRead = typeof readCompleteStream;

function storedEvent(streamVersion: number): StoredEvent {
  return {
    eventId: `evt_${streamVersion}` as never,
    streamId: STREAM_ID,
    streamVersion,
    globalPosition: String(streamVersion) as never,
    tenantId: "tnt_complete" as never,
    eventType: "commerce.order.line-added",
    payload: { sequence: streamVersion },
    metadata: {},
    occurredAt: "2026-07-29T00:00:00.000Z" as never,
    recordedAt: "2026-07-29T00:00:00.000Z" as never,
    performedByUserId: "usr_system" as never,
    forAccountId: "acc_system" as never,
  };
}

function contiguousEvents(firstVersion: number, lastVersion: number): StoredEvent[] {
  return Array.from({ length: lastVersion - firstVersion + 1 }, (_, index) => storedEvent(firstVersion + index));
}

function recordingReader(events: readonly StoredEvent[]): Readonly<{
  calls: ReadStreamInput[];
  reader: CompleteStreamReader;
}> {
  const calls: ReadStreamInput[] = [];
  return {
    calls,
    reader: {
      readStream: async (input) => {
        calls.push(input);
        return events
          .filter((event) => event.streamId === input.streamId)
          .filter((event) => event.streamVersion >= (input.fromVersion ?? 1))
          .slice(0, input.limit);
      },
    },
  };
}

async function assertOffsetContiguousContract(read: CompleteRead): Promise<void> {
  const { calls, reader } = recordingReader(contiguousEvents(1, 537));
  const result = await read(reader, { streamId: STREAM_ID, fromVersion: 37 });

  expect(result.map((event) => event.streamVersion)).toEqual(Array.from({ length: 501 }, (_, index) => index + 37));
  expect(calls).toEqual([
    { streamId: STREAM_ID, fromVersion: 37, limit: EVENT_STORE_READ_PAGE_SIZE_MAX },
    { streamId: STREAM_ID, fromVersion: 537, limit: EVENT_STORE_READ_PAGE_SIZE_MAX },
  ]);
}

const countContinuationMutant: CompleteRead = async (reader, input) => {
  const collected: StoredEvent[] = [];
  let nextCursor = input.fromVersion ?? 1;

  for (;;) {
    const page = await reader.readStream({
      streamId: input.streamId,
      fromVersion: nextCursor,
      limit: EVENT_STORE_READ_PAGE_SIZE_MAX,
    });
    collected.push(...page);
    if (page.length < EVENT_STORE_READ_PAGE_SIZE_MAX) {
      return collected;
    }
    nextCursor = collected.length + 1;
  }
};

describe("readCompleteStream", () => {
  it("issue-6298-acceptance-control: binds offset continuation to the authoritative last streamVersion", async () => {
    await assertOffsetContiguousContract(readCompleteStream);
    await expect(assertOffsetContiguousContract(countContinuationMutant)).rejects.toThrow();
  });

  it("returns empty and short histories after one terminal read", async () => {
    const empty = recordingReader([]);
    await expect(readCompleteStream(empty.reader, { streamId: STREAM_ID })).resolves.toEqual([]);
    expect(empty.calls).toEqual([{ streamId: STREAM_ID, fromVersion: 1, limit: EVENT_STORE_READ_PAGE_SIZE_MAX }]);

    const short = recordingReader(contiguousEvents(1, 3));
    await expect(readCompleteStream(short.reader, { streamId: STREAM_ID })).resolves.toMatchObject([
      { streamVersion: 1 },
      { streamVersion: 2 },
      { streamVersion: 3 },
    ]);
    expect(short.calls).toHaveLength(1);
  });

  it("max500of500-terminal-probe succeeds only after an empty probe", async () => {
    const { calls, reader } = recordingReader(contiguousEvents(1, 500));

    await expect(readCompleteStream(reader, { streamId: STREAM_ID, maxEvents: 500 })).resolves.toHaveLength(500);
    expect(calls).toEqual([
      { streamId: STREAM_ID, fromVersion: 1, limit: EVENT_STORE_READ_PAGE_SIZE_MAX },
      { streamId: STREAM_ID, fromVersion: 501, limit: EVENT_STORE_READ_PAGE_SIZE_MAX },
    ]);
  });

  it("max501of500-rejects rather than returning a capped prefix as complete", async () => {
    const { calls, reader } = recordingReader(contiguousEvents(1, 501));

    await expect(readCompleteStream(reader, { streamId: STREAM_ID, maxEvents: 500 })).rejects.toMatchObject({
      name: "EventStreamTooLongError",
      streamId: STREAM_ID,
      maxEvents: 500,
    });
    expect(calls).toHaveLength(2);
  });

  it("accepts an exact short-page maxEvents bound and rejects one visible event over it", async () => {
    const exact = recordingReader(contiguousEvents(1, 37));
    await expect(readCompleteStream(exact.reader, { streamId: STREAM_ID, maxEvents: 37 })).resolves.toHaveLength(37);

    const over = recordingReader(contiguousEvents(1, 38));
    await expect(readCompleteStream(over.reader, { streamId: STREAM_ID, maxEvents: 37 })).rejects.toBeInstanceOf(
      EventStreamTooLongError,
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects invalid maxEvents %s",
    async (maxEvents) => {
      const { reader } = recordingReader([]);
      await expect(readCompleteStream(reader, { streamId: STREAM_ID, maxEvents })).rejects.toThrow(
        "maxEvents must be a positive integer",
      );
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects invalid fromVersion %s",
    async (fromVersion) => {
      const { reader } = recordingReader([]);
      await expect(readCompleteStream(reader, { streamId: STREAM_ID, fromVersion })).rejects.toThrow(
        "fromVersion must be a positive integer",
      );
    },
  );

  it("rejects a first-page gap at an inclusive non-one cursor", async () => {
    const { reader } = recordingReader(contiguousEvents(38, 40));
    await expect(readCompleteStream(reader, { streamId: STREAM_ID, fromVersion: 37 })).rejects.toThrow(
      "inclusive read expected 37",
    );
  });

  it("rejects an internal gap", async () => {
    const { reader } = recordingReader([storedEvent(1), storedEvent(2), storedEvent(4)]);
    await expect(readCompleteStream(reader, { streamId: STREAM_ID })).rejects.toThrow(
      "non-contiguous stream versions 2 then 4; expected 3",
    );
  });

  it("rejects a cross-page gap", async () => {
    const { reader } = recordingReader([...contiguousEvents(1, 500), storedEvent(502)]);
    await expect(readCompleteStream(reader, { streamId: STREAM_ID })).rejects.toThrow("inclusive read expected 501");
  });

  it("rejects a duplicate stream version", async () => {
    const reader = {
      readStream: vi.fn(async () => [storedEvent(1), storedEvent(2), storedEvent(2)]),
    };
    await expect(readCompleteStream(reader, { streamId: STREAM_ID })).rejects.toThrow(
      "non-contiguous stream versions 2 then 2; expected 3",
    );
  });

  it("rejects a descending stream version", async () => {
    const reader = {
      readStream: vi.fn(async () => [storedEvent(1), storedEvent(2), storedEvent(3), storedEvent(2)]),
    };
    await expect(readCompleteStream(reader, { streamId: STREAM_ID })).rejects.toThrow(
      "non-contiguous stream versions 3 then 2; expected 4",
    );
  });

  it("rejects a store that ignores the continuation cursor", async () => {
    const repeatedPage = contiguousEvents(1, EVENT_STORE_READ_PAGE_SIZE_MAX);
    const reader = { readStream: vi.fn(async () => repeatedPage) };

    await expect(readCompleteStream(reader, { streamId: STREAM_ID })).rejects.toThrow("inclusive read expected 501");
    expect(reader.readStream).toHaveBeenCalledTimes(2);
  });

  it("rejects a store that returns more events than the requested page maximum", async () => {
    const reader = {
      readStream: vi.fn(async () => contiguousEvents(1, EVENT_STORE_READ_PAGE_SIZE_MAX + 1)),
    };
    await expect(readCompleteStream(reader, { streamId: STREAM_ID })).rejects.toThrow(
      "returned 501 events for a 500-event page",
    );
  });

  it("includes an append that becomes visible before the terminal read", async () => {
    const events = contiguousEvents(1, 500);
    const calls: ReadStreamInput[] = [];
    const reader: CompleteStreamReader = {
      readStream: async (input) => {
        calls.push(input);
        if (input.fromVersion === 501) {
          events.push(storedEvent(501));
        }
        return events.filter((event) => event.streamVersion >= (input.fromVersion ?? 1)).slice(0, input.limit);
      },
    };

    await expect(readCompleteStream(reader, { streamId: STREAM_ID })).resolves.toHaveLength(501);
    expect(calls.map((call) => call.fromVersion)).toEqual([1, 501]);
  });

  it("excludes an append that becomes visible only after the terminal read", async () => {
    const events = contiguousEvents(1, 500);
    const reader: CompleteStreamReader = {
      readStream: async (input) => {
        const page = events.filter((event) => event.streamVersion >= (input.fromVersion ?? 1)).slice(0, input.limit);
        if (input.fromVersion === 501) {
          events.push(storedEvent(501));
        }
        return page;
      },
    };

    const result = await readCompleteStream(reader, { streamId: STREAM_ID });
    expect(result).toHaveLength(500);
    expect(events).toHaveLength(501);
  });
});
