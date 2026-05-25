import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { identitySeedIds } from "../seed-support/ids";
import { createIdentityServices } from "./services";
import { createIdentityBootstrapContext } from "./bootstrap-context";

const DEMO_CONTACT_METHOD_ID = "ctm_seed_demo_sms";
const DEMO_PASSKEY_ID = "crd_seed_demo_passkey";
const SUPPORT_CONTACT_METHOD_ID = "ctm_seed_support_email";
const DEMO_PRIMARY_KEY_PREFIX = "sk_seed_demo_primary";
const DEMO_ROTATED_KEY_PREFIX = "sk_seed_demo_rotated";

function isoDate(value: string) {
  return new Date(value).toISOString();
}

async function drainProjectors(projectors: readonly unknown[]) {
  void projectors;
}

export async function seedIdentityDatabase(pool: PgTransactionalPool) {
  const services = createIdentityServices(pool);
  const context = createIdentityBootstrapContext();

  try {
    const existing = await services.db.query("SELECT COUNT(*) AS count FROM identity_accounts");
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Identity already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  const {
    demo,
    collector,
    valueTrader,
    highRollerTrader,
    cardVault,
    sealedStockroom,
    support,
    suspended,
    invitations,
    apiKeys,
  } = identitySeedIds;
  const additionalMarketAccounts = [
    {
      seed: valueTrader,
      name: "Value Trader",
      accountType: "personal",
      displayName: "Binder Builder",
      primaryEmail: "value-trader@chasesets.test",
      givenName: "Value",
      familyName: "Trader",
    },
    {
      seed: highRollerTrader,
      name: "High Roller Trader",
      accountType: "business",
      displayName: "Top Loader Capital",
      primaryEmail: "high-roller@chasesets.test",
      givenName: "High",
      familyName: "Roller",
    },
    {
      seed: cardVault,
      name: "Card Vault",
      accountType: "business",
      displayName: "Card Vault",
      primaryEmail: "card-vault@chasesets.test",
      givenName: "Card",
      familyName: "Vault",
    },
    {
      seed: sealedStockroom,
      name: "Sealed Stockroom",
      accountType: "business",
      displayName: "Pack Runners",
      primaryEmail: "sealed-stockroom@chasesets.test",
      givenName: "Pack",
      familyName: "Runner",
    },
  ] as const;

  await services.accounts.commandHandler({
    streamId: `identity.account-${demo.accountId}`,
    command: {
      type: "CreateAccount",
      accountId: demo.accountId,
      name: "Demo Account",
      accountType: "business",
      displayName: "Chase Sets",
    },
    context,
  });
  await services.accounts.commandHandler({
    streamId: `identity.account-${collector.accountId}`,
    command: {
      type: "CreateAccount",
      accountId: collector.accountId,
      name: "Demo Collector",
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
      name: "Dormant Account",
      accountType: "business",
      displayName: "Dormant Account",
    },
    context,
  });
  await services.accounts.commandHandler({
    streamId: `identity.account-${suspended.accountId}`,
    command: { type: "SuspendAccount" },
    context,
  });
  for (const persona of additionalMarketAccounts) {
    await services.accounts.commandHandler({
      streamId: `identity.account-${persona.seed.accountId}`,
      command: {
        type: "CreateAccount",
        accountId: persona.seed.accountId,
        name: persona.name,
        accountType: persona.accountType,
        displayName: persona.displayName,
      },
      context,
    });
  }

  await services.shippingAddresses.commandHandler({
    streamId: `identity.shipping-address-book-${demo.accountId}`,
    command: {
      type: "AddShippingAddress",
      accountId: demo.accountId,
      shippingAddressId: demo.shippingAddressId,
      label: "Office receiving",
      address: {
        name: "Demo Receiving",
        company: "Chase Sets",
        line1: "100 Market Street",
        line2: null,
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
        phone: "312 555 0101",
        email: "receiving@chasesets.test",
      },
      makeDefault: true,
      addedAt: isoDate("2026-03-01T10:00:00.000Z"),
    },
    context,
  });
  await services.shippingAddresses.commandHandler({
    streamId: `identity.shipping-address-book-${collector.accountId}`,
    command: {
      type: "AddShippingAddress",
      accountId: collector.accountId,
      shippingAddressId: collector.shippingAddressId,
      label: "Home",
      address: {
        name: "Demo Collector",
        company: null,
        line1: "42 Binder Lane",
        line2: null,
        city: "Evanston",
        state: "IL",
        postalCode: "60201",
        country: "US",
        phone: null,
        email: "collector@chasesets.test",
      },
      makeDefault: true,
      addedAt: isoDate("2026-03-01T10:05:00.000Z"),
    },
    context,
  });

  await services.users.commandHandler({
    streamId: `identity.user-${demo.userId}`,
    command: {
      type: "CreateUser",
      userId: demo.userId,
      displayName: "Demo Account",
      primaryEmail: "demo@chasesets.test",
      givenName: "Demo",
      familyName: "Account",
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${demo.userId}`,
    command: {
      type: "AddContactMethod",
      contactMethodId: DEMO_CONTACT_METHOD_ID,
      contactMethodType: "phone",
      value: "312 555 0101",
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${demo.userId}`,
    command: {
      type: "VerifyContactMethod",
      contactMethodId: DEMO_CONTACT_METHOD_ID,
      verifiedAt: isoDate("2026-03-01T09:00:00.000Z"),
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${demo.userId}`,
    command: {
      type: "EnableAuthMethod",
      authMethod: "password",
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${demo.userId}`,
    command: {
      type: "EnableAuthMethod",
      authMethod: "passkey",
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${demo.userId}`,
    command: {
      type: "AttachPasswordCredential",
      credentialId: demo.credentialId,
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${demo.userId}`,
    command: {
      type: "RegisterPasskeyCredential",
      credentialId: DEMO_PASSKEY_ID,
    },
    context,
  });

  await services.users.commandHandler({
    streamId: `identity.user-${collector.userId}`,
    command: {
      type: "CreateUser",
      userId: collector.userId,
      displayName: "Demo Collector",
      primaryEmail: "collector@chasesets.test",
      givenName: "Demo",
      familyName: "Collector",
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${collector.userId}`,
    command: {
      type: "EnableAuthMethod",
      authMethod: "password",
    },
    context,
  });
  await services.users.commandHandler({
    streamId: `identity.user-${collector.userId}`,
    command: {
      type: "AttachPasswordCredential",
      credentialId: collector.credentialId,
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
  for (const persona of additionalMarketAccounts) {
    await services.users.commandHandler({
      streamId: `identity.user-${persona.seed.userId}`,
      command: {
        type: "CreateUser",
        userId: persona.seed.userId,
        displayName: persona.name,
        primaryEmail: persona.primaryEmail,
        givenName: persona.givenName,
        familyName: persona.familyName,
      },
      context,
    });
    await services.users.commandHandler({
      streamId: `identity.user-${persona.seed.userId}`,
      command: {
        type: "EnableAuthMethod",
        authMethod: "password",
      },
      context,
    });
    await services.users.commandHandler({
      streamId: `identity.user-${persona.seed.userId}`,
      command: {
        type: "AttachPasswordCredential",
        credentialId: persona.seed.credentialId,
      },
      context,
    });
  }

  await services.memberships.commandHandler({
    streamId: `identity.membership-${demo.membershipId}`,
    command: {
      type: "GrantMembership",
      membershipId: demo.membershipId,
      userId: demo.userId,
      accountId: demo.accountId,
      roleKey: "owner",
    },
    context,
  });
  await services.memberships.commandHandler({
    streamId: `identity.membership-${collector.membershipId}`,
    command: {
      type: "GrantMembership",
      membershipId: collector.membershipId,
      userId: collector.userId,
      accountId: collector.accountId,
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
      accountId: demo.accountId,
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
  for (const persona of additionalMarketAccounts) {
    await services.memberships.commandHandler({
      streamId: `identity.membership-${persona.seed.membershipId}`,
      command: {
        type: "GrantMembership",
        membershipId: persona.seed.membershipId,
        userId: persona.seed.userId,
        accountId: persona.seed.accountId,
        roleKey: "owner",
      },
      context,
    });
  }

  for (const consent of [demo, collector, valueTrader, highRollerTrader, cardVault, sealedStockroom]) {
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
      accountId: demo.accountId,
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
      accountId: demo.accountId,
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
      accountId: demo.accountId,
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
      accountId: demo.accountId,
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

  await services.apiKeys.commandHandler({
    streamId: `identity.api-key-${demo.apiKeyId}`,
    command: {
      type: "CreateApiKey",
      apiKeyId: demo.apiKeyId,
      userId: demo.userId,
      name: "Primary integration",
      keyPrefix: DEMO_PRIMARY_KEY_PREFIX,
    },
    context,
  });
  await services.apiKeys.commandHandler({
    streamId: `identity.api-key-${demo.apiKeyId}`,
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
      userId: demo.userId,
      name: "Legacy automation key",
      keyPrefix: "sk_seed_demo_legacy",
    },
    context,
  });
  await services.apiKeys.commandHandler({
    streamId: `identity.api-key-${apiKeys.rotatedRevoked}`,
    command: {
      type: "RotateApiKey",
      keyPrefix: DEMO_ROTATED_KEY_PREFIX,
    },
    context,
  });
  await services.apiKeys.commandHandler({
    streamId: `identity.api-key-${apiKeys.rotatedRevoked}`,
    command: { type: "RevokeApiKey" },
    context,
  });

  await drainProjectors(services.projectors);
}
