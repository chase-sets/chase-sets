import { describe, expect, it } from "vitest";
import { mapInvitationAcceptanceLinkRequestedToNotification } from "./notification-intents";

describe("invitation acceptance notification intent", () => {
  it("carries the recipient, account, role, and tokenized acceptance link", () => {
    const message = mapInvitationAcceptanceLinkRequestedToNotification({
      email: "recipient@example.com",
      invitationLink: "https://marketplace.test/invite/ivt_1?token=invite_token",
      accountName: "Competitive Cards",
      roleLabel: "Viewer",
      correlationId: "trace_1",
      idempotencyKey: "invite_1",
    });

    expect(message).toMatchObject({
      messageType: "auth.invitation-acceptance-link.requested",
      templateId: "auth_invitation_acceptance_link",
      templateData: {
        invitationLink: "https://marketplace.test/invite/ivt_1?token=invite_token",
        accountName: "Competitive Cards",
        roleLabel: "Viewer",
      },
      channels: [
        expect.objectContaining({
          channel: "email",
          to: [{ email: "recipient@example.com" }],
          subject: "You're invited to Competitive Cards",
        }),
      ],
    });
  });
});
