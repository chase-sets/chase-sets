import { createTransactionalEmailNotificationMessage, type NotificationMessage } from "@chase-sets/notifications";

export type MagicLinkRequestedEmailIntentInput = Readonly<{
  email: string;
  magicLink: string;
  correlationId: string;
  idempotencyKey: string;
}>;

export function mapMagicLinkRequestedToTransactionalEmail(
  input: MagicLinkRequestedEmailIntentInput,
): NotificationMessage {
  return createTransactionalEmailNotificationMessage({
    messageType: "auth.magic-link.requested",
    criticality: "security",
    to: [{ email: input.email }],
    subject: "Your Chase Sets sign-in link",
    templateId: "auth_magic_link",
    templateVersion: 1,
    locale: "en",
    templateData: {
      magicLink: input.magicLink,
    },
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    actor: {
      userId: null,
      accountId: null,
    },
  });
}
