import { createHash } from "node:crypto";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as JsonObject;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key]!)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export class ListingRequestConflictError extends Error {
  constructor() {
    super("Listing request key was already used for a different command.");
    this.name = "ListingRequestConflictError";
  }
}

export function listingRequestFingerprint(command: JsonObject, context: EventStoreContext): string {
  return createHash("sha256")
    .update(canonical({ command, account: context.audit.forAccountId, actor: context.audit.performedByUserId }))
    .digest("hex");
}

export type ListingRequestInput<Result extends JsonObject> = Readonly<{
  accountId: string;
  idempotencyKey: string;
  command: JsonObject;
  context: EventStoreContext;
  prepare: () => Promise<Readonly<{ result: Result; appends: readonly AppendToStreamInput[] }>>;
}>;

/** Shared preparation for single and bulk atomic owner requests, including durable no-op results. */
export async function prepareListingRequest<Result extends JsonObject>(
  eventStore: EventStore,
  input: ListingRequestInput<Result>,
) {
  if (input.context.audit.forAccountId !== input.accountId || !input.context.audit.performedByUserId) {
    throw new Error("Listing request account authority mismatch.");
  }
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200) {
    throw new Error("Listing request requires a bounded idempotency key.");
  }
  const identity = canonical([input.accountId, input.idempotencyKey]);
  const streamId = `marketplace.listing-request-${createHash("sha256").update(identity).digest("hex")}`;
  const fingerprint = listingRequestFingerprint(input.command, input.context);
  async function replay(): Promise<Result | null> {
    const events = await eventStore.readStream({ streamId, limit: 2 });
    if (events.length === 0) return null;
    const event = events[0]!;
    if (
      events.length !== 1 ||
      event.eventType !== "marketplace.listing-request.completed" ||
      event.payload.fingerprint !== fingerprint ||
      event.forAccountId !== input.accountId
    ) {
      throw new ListingRequestConflictError();
    }
    if (!event.payload.result || typeof event.payload.result !== "object" || Array.isArray(event.payload.result)) {
      throw new Error("Listing request result is invalid.");
    }
    recordCommittedEvents([event]);
    return event.payload.result as Result;
  }
  async function recover(error: unknown): Promise<Result> {
    const committed = await replay();
    if (committed) return committed;
    throw error;
  }
  const prior = await replay();
  if (prior) return { result: prior, appends: [], recover };
  try {
    const prepared = await input.prepare();
    if (prepared.appends.some((append) => append.streamId === streamId)) {
      throw new Error("Listing request cannot append its own result twice.");
    }
    return {
      result: prepared.result,
      recover,
      appends: [
        ...prepared.appends,
        {
          streamId,
          expectedVersion: "no_stream",
          context: input.context,
          events: [
            {
              eventType: "marketplace.listing-request.completed",
              payload: { schemaVersion: 1, fingerprint, result: prepared.result },
            },
          ],
        },
      ] satisfies readonly AppendToStreamInput[],
    };
  } catch (error) {
    // A competing identical request may have committed after our first read.
    // Replaying only a durable request result also handles an unknown append outcome.
    return { result: await recover(error), appends: [], recover };
  }
}

/** The result and every participating owner/version guard commit together. */
export function createListingRequestExecutor(eventStore: EventStore) {
  return async <Result extends JsonObject>(input: ListingRequestInput<Result>): Promise<Result> => {
    const prepared = await prepareListingRequest(eventStore, input);
    if (prepared.appends.length === 0) return prepared.result;
    if (!eventStore.appendToStreams) throw new Error("Atomic listing request persistence is unavailable.");
    try {
      const results = await eventStore.appendToStreams(prepared.appends);
      recordCommittedEvents(results.flatMap((result) => result.storedEvents));
      return prepared.result;
    } catch (error) {
      return prepared.recover(error);
    }
  };
}
