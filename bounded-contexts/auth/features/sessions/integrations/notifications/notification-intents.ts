import type { NotificationMessage } from "@chase-sets/outbound-messaging";

export type GuestCheckoutClaimLinkRequestedNotificationIntentInput = Readonly<{
  email: string;
  claimLink: string;
  correlationId: string;
  idempotencyKey: string;
}>;

export type PhoneCodeRequestedNotificationIntentInput = Readonly<{
  phone: string;
  code: string;
  correlationId: string;
  idempotencyKey: string;
}>;

export function mapGuestCheckoutClaimLinkRequestedToNotification(
  input: GuestCheckoutClaimLinkRequestedNotificationIntentInput,
): NotificationMessage {
  return {
    messageType: "auth.guest-checkout-claim-link.requested",
    criticality: "security",
    title: "Save your Chase Sets order",
    body: "Use this secure link to save your guest checkout order.",
    templateId: "auth_guest_checkout_claim_link",
    templateVersion: 1,
    locale: "en",
    templateData: {
      claimLink: input.claimLink,
    },
    channels: [
      {
        channel: "email",
        to: [{ email: input.email }],
        subject: "Save your Chase Sets order",
        templateId: "auth_guest_checkout_claim_link",
        templateVersion: 1,
        templateData: {
          claimLink: input.claimLink,
        },
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
