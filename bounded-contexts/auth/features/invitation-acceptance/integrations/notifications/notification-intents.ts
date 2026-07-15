import type { NotificationMessage } from "@chase-sets/outbound-messaging";

export type InvitationAcceptanceLinkRequestedNotificationIntentInput = Readonly<{
  email: string;
  invitationLink: string;
  accountName: string;
  roleLabel: string;
  correlationId: string;
  idempotencyKey: string;
}>;

export function mapInvitationAcceptanceLinkRequestedToNotification(
  input: InvitationAcceptanceLinkRequestedNotificationIntentInput,
): NotificationMessage {
  return {
    messageType: "auth.invitation-acceptance-link.requested",
    criticality: "security",
    title: `You're invited to ${input.accountName}`,
    body: "Use this secure link to accept your Chase Sets invitation.",
    templateId: "auth_invitation_acceptance_link",
    templateVersion: 1,
    locale: "en",
    templateData: {
      invitationLink: input.invitationLink,
      accountName: input.accountName,
      roleLabel: input.roleLabel,
    },
    channels: [
      {
        channel: "email",
        to: [{ email: input.email }],
        subject: `You're invited to ${input.accountName}`,
        templateId: "auth_invitation_acceptance_link",
        templateVersion: 1,
        templateData: {
          invitationLink: input.invitationLink,
          accountName: input.accountName,
          roleLabel: input.roleLabel,
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
