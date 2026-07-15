import { defineTransactionalEmail, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import { mapMagicLinkRequestedToTransactionalEmail } from "./transactional-email-intents";

export const AUTH_SESSION_TRANSACTIONAL_EMAIL_PROJECTION = "auth-session-transactional-email-projection";

type AuthMagicLinkRequestedData = Readonly<{
  tokenId: string;
  userId: string | null;
  email: string;
  expiresAt: string;
  origin?: string;
  landingPath?: string;
  returnTo?: string | null;
}>;

export type MagicLinkDeliveryTokenStore = Readonly<{
  getMagicLinkDeliveryToken: (tokenId: string) => Promise<string | null>;
  clearMagicLinkDeliveryToken: (tokenId: string) => Promise<void>;
}>;

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

export function buildAuthSessionTransactionalEmailProjectionHandlers(
  outbox: NotificationOutbox,
  deliveryTokens: MagicLinkDeliveryTokenStore,
  projectionName = AUTH_SESSION_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  return defineTransactionalEmail<
    AuthMagicLinkRequestedData,
    { email: string; magicLink: string },
    "auth.magic-link.requested"
  >({
    outbox,
    projectionName,
    on: "auth.magic-link.requested",
    recipient: async (data) => {
      const token = await deliveryTokens.getMagicLinkDeliveryToken(data.tokenId);
      return token
        ? {
            email: data.email,
            magicLink: buildMagicLinkUrl({
              token,
              origin: data.origin,
              landingPath: data.landingPath,
              returnTo: data.returnTo,
            }),
          }
        : null;
    },
    template: (data, { recipient, correlationId }) =>
      mapMagicLinkRequestedToTransactionalEmail({
        email: recipient.email,
        magicLink: recipient.magicLink,
        correlationId,
        idempotencyKey: `auth:magic-link:${data.tokenId}`,
      }),
    afterEnqueue: (data) => deliveryTokens.clearMagicLinkDeliveryToken(data.tokenId),
  });
}
