import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { mapMagicLinkRequestedToTransactionalEmail } from "./transactional-email-intents";

export const AUTH_SESSION_TRANSACTIONAL_EMAIL_PROJECTION = "auth-session-transactional-email-projection";

export type AuthMagicLinkRequestedEvent = Readonly<
  TransportEvent & {
    type: "auth.magic-link.requested";
    data: Readonly<{
      tokenId: string;
      userId: string | null;
      email: string;
      expiresAt: string;
      origin?: string;
      landingPath?: string;
      returnTo?: string | null;
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

function safeOrigin(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return "https://chasesets.com";
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "https://chasesets.com";
    }
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())) {
      url.protocol = "https:";
    }
    return url.origin;
  } catch {
    return "https://chasesets.com";
  }
}

function safeLandingPath(value: unknown) {
  const path = typeof value === "string" ? value.trim() : "";
  return path.startsWith("/") && !path.startsWith("//") ? path : "/sign-in/magic";
}

function safeReturnTo(value: unknown) {
  const path = typeof value === "string" ? value.trim() : "";
  return path.startsWith("/") && !path.startsWith("//") ? path : null;
}

export function buildMagicLinkUrl(
  input: Readonly<{
    token: string;
    origin?: string;
    landingPath?: string;
    returnTo?: string | null;
  }>,
) {
  const url = new URL(safeLandingPath(input.landingPath), safeOrigin(input.origin));
  url.searchParams.set("token", input.token);
  const returnTo = safeReturnTo(input.returnTo);
  if (returnTo) {
    url.searchParams.set("returnTo", returnTo);
  }
  return url.toString();
}

export async function projectAuthSessionEventToTransactionalEmail(
  outbox: NotificationOutbox,
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
  const magicLinkUrl = buildMagicLinkUrl({
    token: magicLink,
    origin: data.origin,
    landingPath: data.landingPath,
    returnTo: data.returnTo,
  });

  await outbox.enqueueNotification({
    message: mapMagicLinkRequestedToTransactionalEmail({
      email: data.email,
      magicLink: magicLinkUrl,
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
  outbox: NotificationOutbox,
  deliveryTokens: MagicLinkDeliveryTokenStore,
  projectionName = AUTH_SESSION_TRANSACTIONAL_EMAIL_PROJECTION,
): ProjectorHandlerMap {
  return {
    "auth.magic-link.requested": (event) =>
      projectAuthSessionEventToTransactionalEmail(outbox, deliveryTokens, event, projectionName),
  };
}
