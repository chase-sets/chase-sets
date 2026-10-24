import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, EventId, UserId } from "@chase-sets/primitives/typed-ids";
import { createHash } from "node:crypto";
import type { JsonObject } from "@chase-sets/primitives/json";

export async function appendRegistrationCompleted(
  eventStore: EventStore,
  context: EventStoreContext,
  input: Readonly<{ accountId: AccountId; userId: UserId }>,
): Promise<void> {
  const key = `identity:registration:${input.accountId}`;
  await appendLifecycleEvent(eventStore, context, `identity.registration-${input.accountId}`, {
    eventId: stableEventId(key),
    eventType: "identity.registration.completed",
    payload: input,
  });
}

export async function appendOnboardingCompleted(
  eventStore: EventStore,
  context: EventStoreContext,
  input:
    | Readonly<{
        accountId: AccountId;
        userId: UserId;
        onboardingPath: "guest-account";
        invitationId?: never;
        idempotencyKey: string;
      }>
    | Readonly<{
        accountId: AccountId;
        userId: UserId;
        onboardingPath: "invitation";
        invitationId: string;
        idempotencyKey: string;
      }>,
): Promise<void> {
  const { idempotencyKey, ...payload } = input;
  await appendLifecycleEvent(eventStore, context, `identity.onboarding-${digest(idempotencyKey)}`, {
    eventId: stableEventId(idempotencyKey),
    eventType: "identity.onboarding.completed",
    payload,
  });
}

async function appendLifecycleEvent(
  eventStore: EventStore,
  context: EventStoreContext,
  streamId: string,
  event: Readonly<{ eventId: EventId; eventType: string; payload: JsonObject }>,
) {
  try {
    await eventStore.appendToStream({ streamId, expectedVersion: "no_stream", events: [event], context });
  } catch (error) {
    if (isConcurrencyConflict(error)) return;
    // Cross-context CSAT publication is asynchronous and must not turn a
    // committed registration or onboarding operation into a failed response.
    return;
  }
}

function stableEventId(key: string): EventId {
  return `evt_lifecycle_${digest(key)}` as EventId;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isConcurrencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
}
