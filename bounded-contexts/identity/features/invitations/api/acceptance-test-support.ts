import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import {
  createInternalSystemTestActor,
  createTestEventStoreContext,
} from "@chase-sets/bounded-context-runtime/test-support";
import { invitationEmailFingerprint, type InvitationAcceptanceOperation } from "./acceptance-operation";

export const acceptanceContext = createTestEventStoreContext(
  createInternalSystemTestActor({ userId: "usr_recipient", accountId: "acc_invited" }),
);
export const acceptanceOperation: InvitationAcceptanceOperation = {
  version: 1,
  attemptId: "01c9f50d-cb3e-42ac-a0a8-8b5f887a01ea",
  invitationId: "ivt_invited",
  accountId: "acc_invited",
  userId: "usr_recipient",
  membershipId: "mbr_reserved",
  roleKey: "viewer",
  emailFingerprint: invitationEmailFingerprint("recipient@example.com"),
  bindingDigest: "b".repeat(64),
};
export async function seedAcceptance(store: EventStore, withUser = true) {
  const expiresAt = new Date(Date.now() + 86400_000 * 7).toISOString();
  const participants: readonly Pick<AppendToStreamInput, "streamId" | "events">[] = [
    {
      streamId: "identity.account-acc_invited",
      events: [
        {
          eventType: "identity.account.created",
          payload: { accountId: "acc_invited", accountType: "business", name: "Invited", displayName: "Invited" },
        },
      ],
    },
    ...(withUser
      ? [
          {
            streamId: "identity.user-usr_recipient",
            events: [
              {
                eventType: "identity.user.created",
                payload: {
                  userId: "usr_recipient",
                  displayName: "Recipient",
                  primaryEmail: "recipient@example.com",
                  primaryContactMethod: {
                    contactMethodId: "ctm_recipient",
                    type: "email",
                    value: "recipient@example.com",
                    verifiedAt: null,
                  },
                },
              },
            ],
          },
        ]
      : []),
    {
      streamId: "identity.invitation-ivt_invited",
      events: [
        {
          eventType: "identity.invitation.created",
          payload: {
            invitationId: "ivt_invited",
            accountId: "acc_invited",
            roleKey: "viewer",
            email: "recipient@example.com",
            expiresAt,
          },
        },
        {
          eventType: "identity.invitation.acceptance-token-issued",
          payload: { tokenHash: "existing-store-token-hash", expiresAt },
        },
      ],
    },
  ];
  for (const input of participants)
    await store.appendToStream({ ...input, expectedVersion: "no_stream", context: acceptanceContext });
}
