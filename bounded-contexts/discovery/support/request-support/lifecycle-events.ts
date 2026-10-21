import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, EventId, SessionId } from "@chase-sets/primitives/typed-ids";
import { createHash } from "node:crypto";

export async function appendSearchSessionStarted(
  eventStore: EventStore,
  context: EventStoreContext,
  input: Readonly<{ accountId: AccountId; sessionId: SessionId }>,
): Promise<void> {
  const key = `discovery:search-session:${input.sessionId}`;
  try {
    await eventStore.appendToStream({
      streamId: `discovery.search-session-${digest(key)}`,
      expectedVersion: "no_stream",
      events: [{ eventId: `evt_search_${digest(key)}` as EventId, eventType: "discovery.search-session.started", payload: input }],
      context,
    });
  } catch (error) {
    if (!isConcurrencyConflict(error)) throw error;
  }
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isConcurrencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
}
