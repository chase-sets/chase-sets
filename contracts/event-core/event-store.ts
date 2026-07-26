import type { AppendToStreamInput, ReadAllInput, ReadStreamInput, StoredEvent } from "./storage";

export type AppendToStreamsResult = Readonly<{
  streamId: string;
  storedEvents: readonly StoredEvent[];
}>;

/**
 * Per-stream outcome of an independent multi-stream append (see
 * `appendToStreamsIndependently` below): unlike `appendToStreams`, one
 * stream's failure never rolls back another stream's events.
 *
 * - "appended": new events were written for this stream (or an idempotent
 *   retry matched previously-stored events byte-for-byte).
 * - "no_op": the input carried zero events (e.g. a decider suppressed a
 *   no-op command) -- nothing was written, nothing failed.
 * - "conflict": the stream's expected version did not match its current
 *   version (or its stream row was otherwise unappendable); `error` carries
 *   the same `EventStoreError` shape `appendToStream` would have thrown.
 */
export type AppendToStreamsIndependentOutcome = "appended" | "no_op" | "conflict";

export type AppendToStreamsIndependentResult = Readonly<{
  streamId: string;
  outcome: AppendToStreamsIndependentOutcome;
  storedEvents: readonly StoredEvent[];
  error?: EventStoreError;
}>;

export type AppendToStreamsIndependentlyTelemetry = Readonly<{
  /** Distinguishes this chunk's lock-hold samples from ordinary command appends (e.g. "bulk_chunk_append"). */
  holderKind?: string;
  /** The context that issued the chunk, for lock-hold attribution (e.g. "marketplace"). */
  sourceContextName?: string;
}>;

export type AppendToStreamsIndependentlyOptions = Readonly<{
  telemetry?: AppendToStreamsIndependentlyTelemetry;
}>;

export type EventStore = Readonly<{
  appendToStream: (input: AppendToStreamInput) => Promise<readonly StoredEvent[]>;
  /**
   * Appends events for many streams in ONE all-or-nothing transaction: any
   * stream's expected-version mismatch rolls back every stream's events.
   *
   * Every input's `expectedVersion` is enforced, INCLUDING an input that
   * carries zero events. A zero-event input is a pure version guard: a caller
   * that read some stream's state and needs this whole append to fail if that
   * stream moved in the meantime includes it without contributing history to
   * it. Skipping the check for empty inputs would make such a guard silently
   * inert, so a decider that suppresses its command must pass the version it
   * actually read (or "any") rather than relying on empty inputs being
   * ignored. `appendToStream` keeps the single-stream shortcut -- with no other
   * participant in the transaction there is nothing for a guard to protect.
   */
  appendToStreams?: (inputs: readonly AppendToStreamInput[]) => Promise<readonly AppendToStreamsResult[]>;
  /**
   * Appends events for many streams in ONE transaction (one advisory-lock
   * acquisition window, one multi-row event INSERT spanning every stream),
   * but -- unlike `appendToStreams` -- isolates per-stream failures: a
   * version conflict on one stream excludes only that stream's events from
   * the shared INSERT and is reported back as a "conflict" outcome, while
   * every other stream in the batch still commits. This is the chunk
   * primitive bulk multi-listing appends (m113's throughput lane) are built
   * on; ordinary cross-stream-consistent callers (e.g. hold-plus-reservation)
   * must keep using `appendToStreams`, which stays all-or-nothing.
   */
  appendToStreamsIndependently?: (
    inputs: readonly AppendToStreamInput[],
    options?: AppendToStreamsIndependentlyOptions,
  ) => Promise<readonly AppendToStreamsIndependentResult[]>;
  readStream: (input: ReadStreamInput) => Promise<readonly StoredEvent[]>;
  readAll: (input?: ReadAllInput) => Promise<readonly StoredEvent[]>;
}>;

export type EventStoreErrorCode = "concurrency_conflict" | "payload_too_large" | "infrastructure_failure";

export type EventStoreError = Error &
  Readonly<{
    code: EventStoreErrorCode;
    details?: Record<string, unknown>;
  }>;

export function createEventStoreError(
  code: EventStoreErrorCode,
  message: string,
  details?: Record<string, unknown>,
): EventStoreError {
  const error = new Error(message) as EventStoreError;

  (error as { code: EventStoreErrorCode }).code = code;

  if (details) {
    (error as { details: Record<string, unknown> }).details = details;
  }

  return error;
}
