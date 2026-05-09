import type { TransactionalEmailGateway } from "@chase-sets/communications-email";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { mapMagicLinkRequestedToTransactionalEmail } from "./transactional-email-intents";

export type AuthMagicLinkRequestedEvent = Readonly<
  TransportEvent & {
    type: "auth.magic-link.requested";
    data: Readonly<{
      tokenId: string;
      userId: string | null;
      email: string;
      magicLink: string;
      expiresAt: string;
    }>;
  }
>;

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

export async function projectAuthSessionEventToTransactionalEmail(
  gateway: TransactionalEmailGateway,
  event: TransportEvent,
) {
  if (event.type !== "auth.magic-link.requested") {
    return;
  }

  const data = event.data as AuthMagicLinkRequestedEvent["data"];
  await gateway.sendTransactionalEmail(
    mapMagicLinkRequestedToTransactionalEmail({
      email: data.email,
      magicLink: data.magicLink,
      correlationId: correlationIdFromEvent(event),
      idempotencyKey: `auth:magic-link:${data.tokenId}`,
    }),
  );
}

export function buildAuthSessionTransactionalEmailProjectionHandlers(
  gateway: TransactionalEmailGateway,
): ProjectorHandlerMap {
  return {
    "auth.magic-link.requested": (event) =>
      projectAuthSessionEventToTransactionalEmail(gateway, event),
  };
}
