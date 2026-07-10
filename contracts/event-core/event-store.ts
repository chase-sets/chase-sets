import type { AppendToStreamInput, ReadAllInput, ReadStreamInput, StoredEvent } from "./storage";

export type AppendToStreamsResult = Readonly<{
  streamId: string;
  storedEvents: readonly StoredEvent[];
}>;

export type EventStore = Readonly<{
  appendToStream: (input: AppendToStreamInput) => Promise<readonly StoredEvent[]>;
  appendToStreams?: (inputs: readonly AppendToStreamInput[]) => Promise<readonly AppendToStreamsResult[]>;
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
