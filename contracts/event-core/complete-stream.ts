import { EVENT_STORE_READ_PAGE_SIZE_MAX } from "./storage";
import type { StoredEvent, StreamId, StreamVersion } from "./storage";
import type { EventStore } from "./event-store";

/**
 * The only capability `readCompleteStream` needs. Narrowing to the one method
 * keeps every caller -- aggregate repository, command support helper, or
 * bounded-context runtime -- able to hand it whatever store it already holds.
 */
export type CompleteStreamReader = Readonly<{
  readStream: EventStore["readStream"];
}>;

export type ReadCompleteStreamInput = Readonly<{
  streamId: StreamId;
  /**
   * INCLUSIVE first version to read, defaulting to 1. Pass
   * `snapshotVersion + 1` to replay only the events a snapshot does not
   * already cover.
   */
  fromVersion?: StreamVersion;
  /**
   * Refuse to materialize a history larger than this. Once this many events
   * have been collected and the last page came back full -- so the stream may
   * still continue -- the read fails closed with `EventStreamTooLongError`
   * rather than handing back a prefix that looks complete. Omitted means no
   * bound; a stream that outgrows a caller's memory budget is a capacity
   * decision that caller must make explicitly.
   */
  maxEvents?: number;
}>;

/**
 * Thrown when a complete-history read hits its caller-declared `maxEvents`
 * bound. It exists so an over-long history is a loud failure, never a silently
 * folded prefix.
 */
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
 * THE complete-history stream read.
 *
 * Every store caps one `readStream` page at `EVENT_STORE_READ_PAGE_SIZE_MAX`
 * and defaults an omitted `limit` to that cap, so a single call can only ever
 * return a prefix. Folding authoritative aggregate state over one such call
 * silently truncates the instant a stream outgrows one page -- the defect that
 * bit PR #5957 and PR #6272 (see #6277). This helper is the one mechanism that
 * turns capped pages back into a complete history:
 *
 * - it pages at exactly the enforced maximum, so no store ever has to reject
 *   or quietly shrink the limit it was given;
 * - it advances with the store's INCLUSIVE `fromVersion` semantics, from the
 *   last returned stream version plus one -- never from a running count, which
 *   would skip or repeat events on any stream whose versions are not a
 *   contiguous run from 1;
 * - it stops only on a short page, which is the sole evidence the store has
 *   that a stream ended;
 * - it fails closed if a full page fails to advance the cursor, so a store
 *   that ignored `fromVersion` produces an error rather than an infinite loop
 *   or a duplicated fold.
 */
export async function readCompleteStream(
  reader: CompleteStreamReader,
  input: ReadCompleteStreamInput,
): Promise<readonly StoredEvent[]> {
  const maxEvents = input.maxEvents;
  if (maxEvents !== undefined && (!Number.isInteger(maxEvents) || maxEvents < 1)) {
    throw new Error("readCompleteStream maxEvents must be a positive integer.");
  }

  const storedEvents: StoredEvent[] = [];
  let fromVersion = input.fromVersion ?? 1;
  if (!Number.isInteger(fromVersion) || fromVersion < 1) {
    throw new Error("readCompleteStream fromVersion must be a positive integer.");
  }

  for (;;) {
    const page = await reader.readStream({
      streamId: input.streamId,
      fromVersion,
      limit: EVENT_STORE_READ_PAGE_SIZE_MAX,
    });

    if (page.length > 0) {
      // A page that begins before the version it was asked for means the store
      // ignored `fromVersion`; continuing would fold the same events twice.
      const firstVersion = page[0].streamVersion;
      const lastVersion = page[page.length - 1].streamVersion;
      if (firstVersion < fromVersion) {
        throw new Error(
          `Event stream '${input.streamId}' returned stream version ${firstVersion} for an inclusive read from version ${fromVersion}.`,
        );
      }
      // Pages are ascending by contract. Advancing from a descending page's
      // last version would move the cursor backwards and never terminate.
      if (lastVersion < firstVersion) {
        throw new Error(
          `Event stream '${input.streamId}' returned a page ordered from version ${firstVersion} down to ${lastVersion}.`,
        );
      }
    }

    storedEvents.push(...page);

    if (page.length < EVENT_STORE_READ_PAGE_SIZE_MAX) {
      return storedEvents;
    }

    if (maxEvents !== undefined && storedEvents.length >= maxEvents) {
      throw new EventStreamTooLongError(input.streamId, maxEvents);
    }

    fromVersion = page[page.length - 1].streamVersion + 1;
  }
}
