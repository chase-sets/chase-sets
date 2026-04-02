import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { identitySeedIds } from "@chase-sets/dev-seeds";
import { createIdentityServices } from "./services";
import { createBootstrapContext } from "./api";
import { upsertPasswordCredential } from "./auth-support/store";

const SELLER_CONTACT_METHOD_ID = "ctm_seed_seller_sms";
const SELLER_PASSKEY_ID = "crd_seed_seller_passkey";
const SUPPORT_CONTACT_METHOD_ID = "ctm_seed_support_email";
const SELLER_PRIMARY_KEY_PREFIX = "sk_seed_seller_primary";
const SELLER_ROTATED_KEY_PREFIX = "sk_seed_seller_rotated";

function isoDate(value: string) {
  return new Date(value).toISOString();
}

async function drainProjectors(projectors: ReadonlyArray<{ runOnce: () => Promise<{ processed: number }> }>) {
  let processed = 0;

  do {
    processed = 0;

    for (const projector of projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export async function seedIdentityDatabase(pool: PgTransactionalPool) {
  const services = createIdentityServices(pool);
  const context = createBootstrapContext();

  try {
    const existing = await services.db.query(
      "SELECT COUNT(*) AS count FROM identity_accounts",
    );
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Identity already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  const { seller, buyer, support, suspended, invitations, apiKeys } = identitySeedIds;

  await services.accounts.commandHandler({
    streamId: `identity.account-${seller.accountId}`,
    command: {
      type: "CreateAccount",
      accountId: seller.accountId,
      name: "Demo Seller",
      accountType: "business",
      displayName: "Chase Sets",
    },
    context,
  });
  await services.accounts.commandHandler({
    streamId: `identity.account-${buyer.accountId}`,
    command: {
      type: "CreateAccount",
      accountId: buyer.accountId,
      name: "Demo Buyer",
      accountType: "personal",
      displayName: "Collector Zero",
    },
    context,
  });
  await services.accounts.commandHandler({
    streamId: `identity.account-${support.accountId}`,
    command: {
      type: "CreateAccount",
      accountId: support.accountId,
      name: "Support Ops",
      accountType: "business",
      displayName: "Support Ops",
    },
    context,
  });
  await services.accounts.commandHandler({
    streamId: `identity.account-${suspended.accountId}`,
    command: {
      type: "CreateAccount",
      accountId: suspended.accountId,
      name: "Dormant Seller",
      accountType: "business",
      displayName: "Dormant Seller",
    },
    context,
  });
  await services.accounts.commandHandler({
    streamId: `identity.account-${suspended.accountId}`,
    command: { type: "SuspendAccount" },
    context,
  });

  await services.users.commandHandler({
    streamId: `identity.user-${seller.userId}`,
    command: {
      type: "CreateUser",
      userId: seller.userId,
      displayName: "Demo Seller",
      primaryEmail: "seller@chasesets.test",
      givenName: "Demo",
      familyName: "Seller",
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${seller.userId}`,
    command: {
      type: "AddContactMethod",
      contactMethodId: SELLER_CONTACT_METHOD_ID,
      contactMethodType: "phone",
      value: "312 555 0101",
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${seller.userId}`,
    command: {
      type: "VerifyContactMethod",
      contactMethodId: SELLER_CONTACT_METHOD_ID,
      verifiedAt: isoDate("2026-03-01T09:00:00.000Z"),
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${seller.userId}`,
    command: {
      type: "EnableAuthMethod",
      authMethod: "password",
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${seller.userId}`,
    command: {
      type: "EnableAuthMethod",
      authMethod: "passkey",
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${seller.userId}`,
    command: {
      type: "AttachPasswordCredential",
      credentialId: seller.credentialId,
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${seller.userId}`,
    command: {
      type: "RegisterPasskeyCredential",
      credentialId: SELLER_PASSKEY_ID,
    },
    context,
  });

  await services.users.commandHandler({
    streamId: `identity.user-${buyer.userId}`,
    command: {
      type: "CreateUser",
      userId: buyer.userId,
      displayName: "Demo Buyer",
      primaryEmail: "buyer@chasesets.test",
      givenName: "Demo",
      familyName: "Buyer",
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${buyer.userId}`,
    command: {
      type: "EnableAuthMethod",
      authMethod: "password",
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${buyer.userId}`,
    command: {
      type: "AttachPasswordCredential",
      credentialId: buyer.credentialId,
    },
    context,
  });

  await services.users.commandHandler({
    streamId: `identity.user-${support.userId}`,
    command: {
      type: "CreateUser",
      userId: support.userId,
      displayName: "Support User",
      primaryEmail: "support@chasesets.test",
      givenName: "Support",
      familyName: "User",
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${support.userId}`,
    command: {
      type: "AddContactMethod",
      contactMethodId: SUPPORT_CONTACT_METHOD_ID,
      contactMethodType: "email",
      value: "support+alerts@chasesets.test",
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${support.userId}`,
    command: {
      type: "VerifyContactMethod",
      contactMethodId: SUPPORT_CONTACT_METHOD_ID,
      verifiedAt: isoDate("2026-03-02T09:00:00.000Z"),
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${support.userId}`,
    command: {
      type: "EnableAuthMethod",
      authMethod: "magic-link",
    },
    context,
  });

  await services.users.commandHandler({
    streamId: `identity.user-${suspended.userId}`,
    command: {
      type: "CreateUser",
      userId: suspended.userId,
      displayName: "Suspended User",
      primaryEmail: "suspended@chasesets.test",
      givenName: "Suspended",
      familyName: "User",
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${suspended.userId}`,
    command: { type: "SuspendUser" },
    context,
  });

  await services.memberships.commandHandler({
    streamId: `identity.membership-${seller.membershipId}`,
    command: {
      type: "GrantMembership",
      membershipId: seller.membershipId,
      userId: seller.userId,
      accountId: seller.accountId,
      roleKey: "owner",
    },
    context,
  });
  await services.memberships.commandHandler({
    streamId: `identity.membership-${buyer.membershipId}`,
    command: {
      type: "GrantMembership",
      membershipId: buyer.membershipId,
      userId: buyer.userId,
      accountId: buyer.accountId,
      roleKey: "owner",
    },
    context,
  });
  await services.memberships.commandHandler({
    streamId: `identity.membership-${support.membershipId}`,
    command: {
      type: "GrantMembership",
      membershipId: support.membershipId,
      userId: support.userId,
      accountId: seller.accountId,
      roleKey: "viewer",
    },
    context,
  });
  await services.memberships.commandHandler({
    streamId: `identity.membership-${support.membershipId}`,
    command: {
      type: "ChangeMembershipRole",
      roleKey: "manager",
    },
    context,
  });
  await services.memberships.commandHandler({
    streamId: `identity.membership-${support.membershipId}`,
    command: { type: "RevokeMembership" },
    context,
  });
  await services.memberships.commandHandler({
    streamId: `identity.membership-${support.membershipId}`,
    command: { type: "ReinstateMembership" },
    context,
  });
  await services.memberships.commandHandler({
    streamId: `identity.membership-${suspended.membershipId}`,
    command: {
      type: "GrantMembership",
      membershipId: suspended.membershipId,
      userId: suspended.userId,
      accountId: suspended.accountId,
      roleKey: "owner",
    },
    context,
  });

  for (const consent of [seller, buyer]) {
    await services.consents.commandHandler({
      streamId: `identity.consent-${consent.consentId}`,
      command: {
        type: "RecordConsent",
        consentId: consent.consentId,
        subjectType: "user",
        userId: consent.userId,
        accountId: consent.accountId,
        policyKey: "terms-of-service",
        policyVersion: "v1",
        recordedAt: isoDate("2026-03-03T12:00:00.000Z"),
      },
      context,
    });
  }

  await services.invitations.commandHandler({
    streamId: `identity.invitation-${support.invitationId}`,
    command: {
      type: "CreateInvitation",
      invitationId: support.invitationId,
      accountId: seller.accountId,
      email: "support@chasesets.test",
      roleKey: "manager",
      expiresAt: isoDate("2026-05-01T00:00:00.000Z"),
    },
    context,
  });
  await services.invitations.commandHandler({
    streamId: `identity.invitation-${support.invitationId}`,
    command: {
      type: "AcceptInvitation",
      userId: support.userId,
    },
    context,
  });

  await services.invitations.commandHandler({
    streamId: `identity.invitation-${invitations.declined}`,
    command: {
      type: "CreateInvitation",
      invitationId: invitations.declined,
      accountId: seller.accountId,
      email: "declined@chasesets.test",
      roleKey: "viewer",
      expiresAt: isoDate("2026-05-03T00:00:00.000Z"),
    },
    context,
  });
  await services.invitations.commandHandler({
    streamId: `identity.invitation-${invitations.declined}`,
    command: { type: "DeclineInvitation" },
    context,
  });

  await services.invitations.commandHandler({
    streamId: `identity.invitation-${invitations.cancelled}`,
    command: {
      type: "CreateInvitation",
      invitationId: invitations.cancelled,
      accountId: seller.accountId,
      email: "cancelled@chasesets.test",
      roleKey: "viewer",
      expiresAt: isoDate("2026-05-05T00:00:00.000Z"),
    },
    context,
  });
  await services.invitations.commandHandler({
    streamId: `identity.invitation-${invitations.cancelled}`,
    command: { type: "CancelInvitation" },
    context,
  });

  await services.invitations.commandHandler({
    streamId: `identity.invitation-${invitations.expired}`,
    command: {
      type: "CreateInvitation",
      invitationId: invitations.expired,
      accountId: seller.accountId,
      email: "expired@chasesets.test",
      roleKey: "viewer",
      expiresAt: isoDate("2026-03-04T00:00:00.000Z"),
    },
    context,
  });
  await services.invitations.commandHandler({
    streamId: `identity.invitation-${invitations.expired}`,
    command: { type: "ExpireInvitation" },
    context,
  });

  await services.sessions.commandHandler({
    streamId: `identity.session-${seller.sessionId}`,
    command: {
      type: "StartSession",
      sessionId: seller.sessionId,
      userId: seller.userId,
      accountId: seller.accountId,
      availableAccountIds: [seller.accountId],
      authenticationMethod: "password",
      expiresAt: isoDate("2026-05-10T00:00:00.000Z"),
    },
    context,
  });
  await services.sessions.commandHandler({
    streamId: `identity.session-${support.sessionId}`,
    command: {
      type: "StartSession",
      sessionId: support.sessionId,
      userId: support.userId,
      accountId: support.accountId,
      availableAccountIds: [support.accountId, seller.accountId],
      authenticationMethod: "magic-link",
      expiresAt: isoDate("2026-05-10T00:00:00.000Z"),
    },
    context,
  });
  await services.sessions.commandHandler({
    streamId: `identity.session-${support.sessionId}`,
    command: {
      type: "SwitchSessionAccount",
      accountId: seller.accountId,
    },
    context,
  });
  await services.sessions.commandHandler({
    streamId: `identity.session-${buyer.sessionId}`,
    command: {
      type: "StartSession",
      sessionId: buyer.sessionId,
      userId: buyer.userId,
      accountId: buyer.accountId,
      availableAccountIds: [buyer.accountId],
      authenticationMethod: "password",
      expiresAt: isoDate("2026-04-15T00:00:00.000Z"),
    },
    context,
  });
  await services.sessions.commandHandler({
    streamId: `identity.session-${buyer.sessionId}`,
    command: { type: "ExpireSession" },
    context,
  });

  await services.apiKeys.commandHandler({
    streamId: `identity.api-key-${seller.apiKeyId}`,
    command: {
      type: "CreateApiKey",
      apiKeyId: seller.apiKeyId,
      userId: seller.userId,
      name: "Primary integration",
      keyPrefix: SELLER_PRIMARY_KEY_PREFIX,
    },
    context,
  });
  await services.apiKeys.commandHandler({
    streamId: `identity.api-key-${seller.apiKeyId}`,
    command: {
      type: "RecordApiKeyUse",
      usedAt: isoDate("2026-03-06T00:00:00.000Z"),
    },
    context,
  });

  await services.apiKeys.commandHandler({
    streamId: `identity.api-key-${apiKeys.rotatedRevoked}`,
    command: {
      type: "CreateApiKey",
      apiKeyId: apiKeys.rotatedRevoked,
      userId: seller.userId,
      name: "Legacy automation key",
      keyPrefix: "sk_seed_seller_legacy",
    },
    context,
  });
  await services.apiKeys.commandHandler({
    streamId: `identity.api-key-${apiKeys.rotatedRevoked}`,
    command: {
      type: "RotateApiKey",
      keyPrefix: SELLER_ROTATED_KEY_PREFIX,
    },
    context,
  });
  await services.apiKeys.commandHandler({
    streamId: `identity.api-key-${apiKeys.rotatedRevoked}`,
    command: { type: "RevokeApiKey" },
    context,
  });

  await upsertPasswordCredential(services.db, {
    credentialId: seller.credentialId,
    userId: seller.userId,
    secretHash: services.auth.hashSecret("seller1234"),
  });
  await upsertPasswordCredential(services.db, {
    credentialId: buyer.credentialId,
    userId: buyer.userId,
    secretHash: services.auth.hashSecret("buyer1234"),
  });

  await drainProjectors(services.projectors);
}
