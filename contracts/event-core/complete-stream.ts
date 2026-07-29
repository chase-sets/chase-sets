import type { EventStore } from "./event-store";
import { EVENT_STORE_READ_PAGE_SIZE_MAX, type StoredEvent, type StreamId, type StreamVersion } from "./storage";

export type CompleteStreamReader = Readonly<{
  readStream: EventStore["readStream"];
}>;

export type ReadCompleteStreamInput = Readonly<{
  streamId: StreamId;
  /** Inclusive first stream version. Defaults to 1. */
  fromVersion?: StreamVersion;
  /**
   * Inclusive maximum number of events that may be returned. The reader probes
   * past a full page at the bound so an exact-bound history succeeds while a
   * visible next event rejects.
   */
  maxEvents?: number;
}>;

export class EventStreamTooLongError extends Error {
  public readonly streamId: StreamId;
  public readonly maxEvents: number;

  public constructor(streamId: StreamId, maxEvents: number) {
    super(`Event stream '${streamId}' exceeded its ${maxEvents} event complete-read bound.`);
    this.name = "EventStreamTooLongError";
    this.streamId = streamId;
    this.maxEvents = maxEvents;
  }
}

/**
 * Reads one complete, contiguous event-stream history from an inclusive cursor.
 *
 * Pages are requested at the EventStore's authoritative maximum. Continuation
 * is derived only from the last returned streamVersion, and a short page is the
 * only terminal signal. The reads do not share a transactional horizon:
 * appends visible before the terminal read may be included, while later appends
 * are excluded. Write callers continue to protect that horizon with the final
 * returned streamVersion as their expected version.
 */
export async function readCompleteStream(
  reader: CompleteStreamReader,
  input: ReadCompleteStreamInput,
): Promise<readonly StoredEvent[]> {
  const initialFromVersion = assertPositiveSafeInteger(input.fromVersion ?? 1, "fromVersion");
  const maxEvents = input.maxEvents === undefined ? undefined : assertPositiveSafeInteger(input.maxEvents, "maxEvents");
  const collected: StoredEvent[] = [];
  let fromVersion = initialFromVersion;

  for (;;) {
    const page = await reader.readStream({
      streamId: input.streamId,
      fromVersion,
      limit: EVENT_STORE_READ_PAGE_SIZE_MAX,
    });

    if (page.length > EVENT_STORE_READ_PAGE_SIZE_MAX) {
      throw new Error(
        `Event stream '${input.streamId}' returned ${page.length} events for a ${EVENT_STORE_READ_PAGE_SIZE_MAX}-event page.`,
      );
    }

    assertContiguousPage(input.streamId, page, fromVersion);

    if (maxEvents !== undefined && collected.length + page.length > maxEvents) {
      throw new EventStreamTooLongError(input.streamId, maxEvents);
    }

    collected.push(...page);

    if (page.length < EVENT_STORE_READ_PAGE_SIZE_MAX) {
      return collected;
    }

    const lastStreamVersion = page[page.length - 1].streamVersion;
    if (!Number.isSafeInteger(lastStreamVersion) || lastStreamVersion === Number.MAX_SAFE_INTEGER) {
      throw new Error(
        `Event stream '${input.streamId}' returned an invalid continuation stream version ${lastStreamVersion}.`,
      );
    }
    fromVersion = lastStreamVersion + 1;
  }
}

function assertContiguousPage(
  streamId: StreamId,
  page: readonly StoredEvent[],
  expectedFirstVersion: StreamVersion,
): void {
  if (page.length === 0) {
    return;
  }

  const firstVersion = page[0].streamVersion;
  if (firstVersion !== expectedFirstVersion) {
    throw new Error(
      `Event stream '${streamId}' returned stream version ${firstVersion}; inclusive read expected ${expectedFirstVersion}.`,
    );
  }

  for (let index = 1; index < page.length; index += 1) {
    const previousVersion = page[index - 1].streamVersion;
    const currentVersion = page[index].streamVersion;
    const expectedVersion = previousVersion + 1;
    if (currentVersion !== expectedVersion) {
      throw new Error(
        `Event stream '${streamId}' returned non-contiguous stream versions ${previousVersion} then ${currentVersion}; expected ${expectedVersion}.`,
      );
    }
  }
}

function assertPositiveSafeInteger(value: number, fieldName: "fromVersion" | "maxEvents"): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`readCompleteStream ${fieldName} must be a positive integer.`);
  }
  return value;
}
