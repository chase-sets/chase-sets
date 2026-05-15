import type { NotificationMessage } from "@chase-sets/notifications";

export type PhoneCodeRequestedNotificationIntentInput = Readonly<{
  phone: string;
  code: string;
  correlationId: string;
  idempotencyKey: string;
}>;

export function mapPhoneCodeRequestedToNotification(
  input: PhoneCodeRequestedNotificationIntentInput,
): NotificationMessage {
  return {
    messageType: "auth.phone-code.requested",
    criticality: "security",
    title: "Your Chase Sets sign-in code",
    body: `Your Chase Sets code is ${input.code}. It expires soon.`,
    templateId: "auth_phone_code",
    templateVersion: 1,
    locale: "en",
    templateData: {
      code: input.code,
    },
    channels: [
      {
        channel: "sms",
        to: { e164: input.phone },
        body: `Your Chase Sets code is ${input.code}. It expires soon.`,
      },
    ],
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    actor: {
      userId: null,
      accountId: null,
    },
  };
}
