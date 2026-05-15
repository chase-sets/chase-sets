import type { TransactionalEmailOutbox } from "@chase-sets/communications-email";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { mapWaitlistSignupRecordedToTransactionalEmail } from "./transactional-email-intents";

export const PUBLIC_PRESENCE_WAITLIST_TRANSACTIONAL_EMAIL_PROJECTION =
  "public-presence-waitlist-transactional-email-projection";

export type WaitlistSignupRecordedEmailEvent = Readonly<
  TransportEvent & {
    type: "public-presence.waitlist-signup.recorded";
    data: Readonly<{
      signupId: string;
      email: string;
    }>;
  }
>;

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

export async function projectWaitlistEventToTransactionalEmail(
  outbox: TransactionalEmailOutbox,
  event: TransportEvent,
  projectionName = PUBLIC_PRESENCE_WAITLIST_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  if (event.type !== "public-presence.waitlist-signup.recorded") {
    return;
  }

  const data = event.data as WaitlistSignupRecordedEmailEvent["data"];
  await outbox.enqueueTransactionalEmail({
    message: mapWaitlistSignupRecordedToTransactionalEmail({
      email: data.email,
      signupId: data.signupId,
      correlationId: correlationIdFromEvent(event),
    }),
    source: {
      sourceEventId: event.id,
      sourceGlobalPosition: event.globalPosition,
      projectionName,
      occurredAt: event.timing.occurredAt,
    },
  });
}

export function buildWaitlistTransactionalEmailProjectionHandlers(
  outbox: TransactionalEmailOutbox,
  projectionName = PUBLIC_PRESENCE_WAITLIST_TRANSACTIONAL_EMAIL_PROJECTION,
): ProjectorHandlerMap {
  return {
    "public-presence.waitlist-signup.recorded": (event) =>
      projectWaitlistEventToTransactionalEmail(outbox, event, projectionName),
  };
}
