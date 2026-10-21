import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";

export async function appendSessionStarted(eventStore: EventStore, context: EventStoreContext) {
  await eventStore.appendToStream({ streamId: "auth.session-ses_1", expectedVersion: "no_stream", context, events: [{ eventType: "auth.session.started", payload: { sessionId: "ses_1", userId: "usr_1", accountId: "acc_1", availableAccountIds: ["acc_1"], authenticationMethod: "password", expiresAt: "2026-01-01T00:00:00.000Z" } }] });
}
