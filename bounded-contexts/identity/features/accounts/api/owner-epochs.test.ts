import { describe, expect, it, vi } from "vitest";
import { decideAccount, evolveAccount, initialAccountState, type AccountEvent } from "../domain/domain";
import { decideUser, evolveUser, initialUserState, type UserEvent } from "../../users/domain/domain";
import { createIdentityOwnerEpochs, identityAuthorityEventClassification, identityOwnerKey } from "./owner-epochs";

const accountEvents: readonly AccountEvent[] = [
  { type: "identity.account.profile-updated", data: { name: "New", displayName: "New" } },
  { type: "identity.account.badge-assigned", data: { badgeKey: "founding-account", founderNumber: 1 } },
  { type: "identity.account.badge-removed", data: { badgeKey: "trusted-seller" } },
  {
    type: "identity.account.founders-window-opened",
    data: { betaAccessStartedAt: "2026-11-01T00:00:00Z", foundersWindowEndsAt: "2026-12-31T00:00:00Z" },
  },
];
const userEvents: readonly UserEvent[] = [
  { type: "identity.user.profile-updated", data: { displayName: "New", givenName: "New", familyName: "Name" } },
  {
    type: "identity.user.contact-method-added",
    data: { contactMethodId: "contact", contactMethodType: "email", value: "synthetic@example.test" },
  },
  {
    type: "identity.user.contact-method-verified",
    data: { contactMethodId: "contact", verifiedAt: "2026-11-01T00:00:00Z" },
  },
  { type: "identity.user.auth-method-enabled", data: { authMethod: "password" } },
  { type: "identity.user.auth-method-disabled", data: { authMethod: "password" } },
  { type: "identity.user.password-credential-attached", data: { credentialId: "credential" } },
  { type: "identity.user.passkey-registered", data: { credentialId: "passkey" } },
  {
    type: "identity.user.social-login-linked",
    data: {
      providerName: "google",
      providerSubject: "synthetic",
      email: "synthetic@example.test",
      linkedAt: "2026-11-01T00:00:00Z",
    },
  },
];

describe("Identity owner event effect classification", () => {
  it("folds every excluded Account/User event to identical consumed fields", () => {
    let account = evolveAccount(
      initialAccountState,
      decideAccount(initialAccountState, {
        type: "CreateAccount",
        accountId: "acc_synthetic" as never,
        accountType: "personal",
        name: "Test",
      })[0],
    );
    for (const event of accountEvents) {
      const next = evolveAccount(account, event);
      expect({ id: next.id, status: next.status }, event.type).toEqual({ id: account.id, status: account.status });
      account = next;
    }
    let user = evolveUser(
      initialUserState,
      decideUser(initialUserState, {
        type: "CreateUser",
        userId: "usr_synthetic" as never,
        displayName: "Test",
        primaryEmail: "synthetic@example.test",
      })[0],
    );
    for (const event of userEvents) {
      const next = evolveUser(user, event);
      expect({ id: next.id, status: next.status }, event.type).toEqual({ id: user.id, status: user.status });
      user = next;
    }
    expect(
      Object.entries(identityAuthorityEventClassification)
        .filter(([, effect]) => effect === "unchanged")
        .map(([type]) => type)
        .sort(),
    ).toEqual([...accountEvents, ...userEvents].map((event) => event.type).sort());
  });
  it("excludes non-owner streams including AccountCapabilityAssignment without consuming them", async () => {
    const unexpected = vi.fn(async () => {
      throw new Error("non-owner data read");
    });
    const epochs = createIdentityOwnerEpochs({ query: unexpected, connect: unexpected });
    for (const streamId of [
      "identity.account-capability-acc_test",
      "identity.invitation-inv_test",
      "identity.api-key-key_test",
      "identity.user-preferences-usr_test",
      "identity.founders-cohort-global",
      "identity.agent-grant-revocation-test",
      "identity.consent-cns_test",
      "identity.shipping-address-book-acc_test",
      "identity.registration-test",
    ]) {
      expect(identityOwnerKey(streamId)).toBeUndefined();
      await epochs.enroll({ query: unexpected }, [
        {
          streamId,
          expectedVersion: "no_stream",
          context: {} as never,
          events: [{ eventType: "not-an-owner-event", payload: {} }],
        },
      ]);
    }
    expect(unexpected).not.toHaveBeenCalled();
  });
});
