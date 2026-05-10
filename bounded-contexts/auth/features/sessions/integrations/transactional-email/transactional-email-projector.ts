import type { TransactionalEmailOutbox } from "@chase-sets/communications-email";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { mapMagicLinkRequestedToTransactionalEmail } from "./transactional-email-intents";

export const AUTH_SESSION_TRANSACTIONAL_EMAIL_PROJECTION =
  "auth-session-transactional-email-projection";

export type AuthMagicLinkRequestedEvent = Readonly<
  TransportEvent & {
    type: "auth.magic-link.requested";
    data: Readonly<{
      tokenId: string;
      userId: string | null;
      email: string;
      expiresAt: string;
    }>;
  }
>;

export type MagicLinkDeliveryTokenStore = Readonly<{
  getMagicLinkDeliveryToken: (tokenId: string) => Promise<string | null>;
  clearMagicLinkDeliveryToken: (tokenId: string) => Promise<void>;
}>;

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

export async function projectAuthSessionEventToTransactionalEmail(
  outbox: TransactionalEmailOutbox,
  deliveryTokens: MagicLinkDeliveryTokenStore,
  event: TransportEvent,
  projectionName = AUTH_SESSION_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  if (event.type !== "auth.magic-link.requested") {
    return;
  }

  const data = event.data as AuthMagicLinkRequestedEvent["data"];
  const magicLink = await deliveryTokens.getMagicLinkDeliveryToken(data.tokenId);
  if (!magicLink) {
    return;
  }

  await outbox.enqueueTransactionalEmail({
    message: mapMagicLinkRequestedToTransactionalEmail({
      email: data.email,
      magicLink,
      correlationId: correlationIdFromEvent(event),
      idempotencyKey: `auth:magic-link:${data.tokenId}`,
    }),
    source: {
      sourceEventId: event.id,
      sourceGlobalPosition: event.globalPosition,
      projectionName,
      occurredAt: event.timing.occurredAt,
    },
  });
  await deliveryTokens.clearMagicLinkDeliveryToken(data.tokenId);
}

export function buildAuthSessionTransactionalEmailProjectionHandlers(
  outbox: TransactionalEmailOutbox,
  deliveryTokens: MagicLinkDeliveryTokenStore,
  projectionName = AUTH_SESSION_TRANSACTIONAL_EMAIL_PROJECTION,
): ProjectorHandlerMap {
  return {
    "auth.magic-link.requested": (event) =>
      projectAuthSessionEventToTransactionalEmail(
        outbox,
        deliveryTokens,
        event,
        projectionName,
      ),
  };
}
