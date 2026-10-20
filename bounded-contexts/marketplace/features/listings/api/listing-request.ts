import { createHash } from "node:crypto";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import { toJsonValue } from "@chase-sets/primitives/json";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}
export class ListingRequestConflictError extends Error {
  constructor() {
    super("Listing request key was already used for a different command.");
  }
}
export function createListingRequestExecutor(eventStore: EventStore) {
  return async function execute<Result extends Record<string, unknown>>(
    input: Readonly<{
      accountId: string;
      idempotencyKey: string;
      command: Record<string, unknown>;
      context: EventStoreContext;
      prepare: () => Promise<Readonly<{ result: Result; appends: readonly AppendToStreamInput[] }>>;
    }>,
  ): Promise<Result> {
    const streamId = `marketplace.listing-request-${createHash("sha256")
      .update(canonical([input.accountId, input.idempotencyKey]))
      .digest("hex")}`;
    const fingerprint = createHash("sha256")
      .update(
        canonical({ command: input.command, account: input.accountId, actor: input.context.audit.performedByUserId }),
      )
      .digest("hex");
    const replay = async () => {
      const events = await eventStore.readStream({ streamId, limit: 2 });
      if (!events.length) return null;
      const event = events[0]!;
      if (
        events.length !== 1 ||
        event.eventType !== "marketplace.listing-request.completed" ||
        event.payload.fingerprint !== fingerprint
      )
        throw new ListingRequestConflictError();
      return event.payload.result as Result;
    };
    const prior = await replay();
    if (prior) return prior;
    if (!eventStore.appendToStreams) throw new Error("Atomic listing request persistence is unavailable.");
    try {
      const prepared = await input.prepare();
      const results = await eventStore.appendToStreams([
        ...prepared.appends,
        {
          streamId,
          expectedVersion: "no_stream",
          context: input.context,
          events: [
            {
              eventType: "marketplace.listing-request.completed",
              payload: { schemaVersion: 1, fingerprint, result: toJsonValue(prepared.result) },
            },
          ],
        },
      ]);
      recordCommittedEvents(results.flatMap((result) => result.storedEvents));
      return prepared.result;
    } catch (error) {
      const committed = await replay();
      if (committed) return committed;
      throw error;
    }
  };
}
