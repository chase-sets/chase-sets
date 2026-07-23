import type { BcSeedOptions, EnvironmentDataProfile } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { identitySeedIds } from "../seed-support/ids";
import { createIdentityServices } from "./services";
import { createIdentityBootstrapContext } from "./bootstrap-context";
import { provisionAdminQaActorFixtures } from "./admin-qa-actor-fixtures";
import type { AccountId, ConsentId, MembershipId, ShippingAddressId, UserId } from "@chase-sets/primitives/typed-ids";
import { IdentityDomainError } from "./common";

const DEMO_CONTACT_METHOD_ID = "ctm_seed_demo_sms";
const DEMO_PRIMARY_EMAIL_CONTACT_METHOD_ID = "ctm_seed_demo_email";
const DEMO_PASSKEY_ID = "crd_seed_demo_passkey";
const SUPPORT_CONTACT_METHOD_ID = "ctm_seed_support_email";
const DEMO_PRIMARY_KEY_PREFIX = "sk_seed_demo_primary";
const DEMO_ROTATED_KEY_PREFIX = "sk_seed_demo_rotated";
const REPRESENTATIVE_SEEDED_AT = "2026-05-27T00:00:00.000Z";
const scenarioTrustedSellerAccountIds = [identitySeedIds.demo.accountId, identitySeedIds.cardVault.accountId] as const;

const representativeAccounts = [
  {
    accountId: "acc_repr_staging_collector_account",
    userId: "usr_repr_staging_collector_user",
    membershipId: "mbr_repr_staging_collector_owner",
    consentId: "cns_repr_staging_collector_terms",
    shippingAddressId: "adr_repr_staging_collector_home",
    contactMethodId: "ctm_repr_staging_collector_email",
    name: "Staging Collector",
    accountType: "personal",
    displayName: "Staging Collector",
    primaryEmail: "staging-collector@chasesets.test",
    givenName: "Staging",
    familyName: "Collector",
    roleKey: "owner",
    shippingAddress: {
      name: "Staging Collector",
      company: null,
      line1: "180 N Wabash Ave",
      line2: "Apt 4B",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: "3125550201",
      email: "staging-collector@chasesets.test",
    },
  },
  {
    accountId: "acc_repr_value_buyer_account",
    userId: "usr_repr_value_buyer_user",
    membershipId: "mbr_repr_value_buyer_owner",
    consentId: "cns_repr_value_buyer_terms",
    shippingAddressId: "adr_repr_value_buyer_home",
    contactMethodId: "ctm_repr_value_buyer_email",
    name: "Value Buyer",
    accountType: "personal",
    displayName: "Value Buyer",
    primaryEmail: "value-buyer@chasesets.test",
    givenName: "Value",
    familyName: "Buyer",
    roleKey: "owner",
    shippingAddress: {
      name: "Value Buyer",
      company: null,
      line1: "401 S 2nd St",
      line2: null,
      city: "Saint Louis",
      state: "MO",
      postalCode: "63102",
      country: "US",
      phone: "3145550202",
      email: "value-buyer@chasesets.test",
    },
  },
  {
    accountId: "acc_repr_card_vault_account",
    userId: "usr_repr_card_vault_user",
    membershipId: "mbr_repr_card_vault_owner",
    consentId: "cns_repr_card_vault_terms",
    shippingAddressId: "adr_repr_card_vault_receiving",
    contactMethodId: "ctm_repr_card_vault_email",
    name: "Card Vault",
    accountType: "business",
    displayName: "Card Vault",
    primaryEmail: "staging-card-vault@chasesets.test",
    givenName: "Card",
    familyName: "Vault",
    roleKey: "owner",
    shippingAddress: {
      name: "Card Vault Receiving",
      company: "Card Vault",
      line1: "720 Olive St",
      line2: "Suite 900",
      city: "Saint Louis",
      state: "MO",
      postalCode: "63101",
      country: "US",
      phone: "3145550203",
      email: "staging-card-vault@chasesets.test",
    },
  },
  {
    accountId: "acc_repr_sealed_stockroom_account",
    userId: "usr_repr_sealed_stockroom_user",
    membershipId: "mbr_repr_sealed_stockroom_owner",
    consentId: "cns_repr_sealed_stockroom_terms",
    shippingAddressId: "adr_repr_sealed_stockroom_receiving",
    contactMethodId: "ctm_repr_sealed_stockroom_email",
    name: "Sealed Stockroom",
    accountType: "business",
    displayName: "Sealed Stockroom",
    primaryEmail: "sealed-stockroom@chasesets.test",
    givenName: "Sealed",
    familyName: "Stockroom",
    roleKey: "owner",
    shippingAddress: {
      name: "Sealed Stockroom Receiving",
      company: "Sealed Stockroom",
      line1: "200 S Meridian St",
      line2: null,
      city: "Indianapolis",
      state: "IN",
      postalCode: "46225",
      country: "US",
      phone: "3175550204",
      email: "sealed-stockroom@chasesets.test",
    },
  },
  {
    accountId: "acc_repr_support_ops_account",
    userId: "usr_repr_support_ops_user",
    membershipId: "mbr_repr_support_ops_owner",
    consentId: "cns_repr_support_ops_terms",
    shippingAddressId: "adr_repr_support_ops_office",
    contactMethodId: "ctm_repr_support_ops_email",
    name: "Support Ops",
    accountType: "business",
    displayName: "Support Ops",
    primaryEmail: "staging-support-ops@chasesets.test",
    givenName: "Support",
    familyName: "Ops",
    roleKey: "owner",
    shippingAddress: {
      name: "Support Ops",
      company: "Chase Sets",
      line1: "221 N LaSalle St",
      line2: "Suite 1200",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: "3125550205",
      email: "staging-support-ops@chasesets.test",
    },
  },
] as const;

function isoDate(value: string) {
  return new Date(value).toISOString();
}

async function ensureScenarioTrustedSellerBadges(
  services: ReturnType<typeof createIdentityServices>,
  context: ReturnType<typeof createIdentityBootstrapContext>,
) {
  for (const accountId of scenarioTrustedSellerAccountIds) {
    await services.accounts.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: {
        type: "AssignAccountBadge",
        badgeKey: "trusted-seller",
      },
      context,
    });
  }
}

export async function seedIdentityDatabase(pool: PgTransactionalPool, _services?: unknown, options?: BcSeedOptions) {
  const services = createIdentityServices(pool);
  const context = createIdentityBootstrapContext();
  const shouldSeedScenario = profileEnabled(options, "scenario-seed");
  const shouldSeedRepresentative = profileEnabled(options, "representative-commerce-state");
  const shouldSeedAdminQaActorFixtures = profileEnabled(options, "admin-qa-actor-fixtures");

  if (!shouldSeedScenario && !shouldSeedRepresentative && !shouldSeedAdminQaActorFixtures) {
    console.log("Identity seed skipped for selected data profiles.");
    return;
  }

  if (!shouldSeedScenario) {
    if (shouldSeedRepresentative) {
      await seedRepresentativeIdentityAccounts(services, context);
    }
    if (shouldSeedAdminQaActorFixtures) {
      await provisionAdminQaActorFixtures(services);
    }
    return;
  }

  try {
    const existing = await services.db.query("SELECT COUNT(*) AS count FROM identity_accounts");
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Identity already contains data. Skipping seed.");
      await ensureScenarioTrustedSellerBadges(services, context);
      if (shouldSeedRepresentative) {
        await seedRepresentativeIdentityAccounts(services, context);
      }
      if (shouldSeedAdminQaActorFixtures) {
        await provisionAdminQaActorFixtures(services);
      }
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
  await ensureScenarioTrustedSellerBadges(services, context);

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
      primaryContactMethod: {
        contactMethodId: DEMO_PRIMARY_EMAIL_CONTACT_METHOD_ID,
        type: "email",
        value: "demo@chasesets.test",
        verifiedAt: isoDate("2026-03-01T09:00:00.000Z"),
      },
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
      assignmentAuthority: { type: "system" },
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
      assignmentAuthority: { type: "system" },
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
      assignmentAuthority: { type: "system" },
    },
    context,
  });
  await services.memberships.commandHandler({
    streamId: `identity.membership-${support.membershipId}`,
    command: {
      type: "ChangeMembershipRole",
      roleKey: "manager",
      assignmentAuthority: { type: "system" },
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
      assignmentAuthority: { type: "system" },
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
        assignmentAuthority: { type: "system" },
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
      assignmentAuthority: { type: "system" },
    },
    context,
  });
  await services.invitations.commandHandler({
    streamId: `identity.invitation-${support.invitationId}`,
    command: {
      type: "IssueInvitationAcceptanceToken",
      tokenHash: "seeded-support-invitation-token",
      expiresAt: isoDate("2026-04-01T00:00:00.000Z"),
    },
    context,
  });
  await services.invitations.commandHandler({
    streamId: `identity.invitation-${support.invitationId}`,
    command: {
      type: "AcceptInvitation",
      userId: support.userId,
      acceptanceTokenHash: "seeded-support-invitation-token",
      acceptedAt: isoDate("2026-03-03T12:00:00.000Z"),
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
      assignmentAuthority: { type: "system" },
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
      assignmentAuthority: { type: "system" },
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
      assignmentAuthority: { type: "system" },
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

  if (shouldSeedRepresentative) {
    await seedRepresentativeIdentityAccounts(services, context);
  }
  if (shouldSeedAdminQaActorFixtures) {
    await provisionAdminQaActorFixtures(services);
  }
}

function profileEnabled(options: BcSeedOptions | undefined, profile: EnvironmentDataProfile): boolean {
  const defaultProfiles: readonly EnvironmentDataProfile[] = [
    "critical-bootstrap",
    "catalog-integration-bootstrap",
    "scenario-seed",
  ];

  return (options?.enabledDataProfiles ?? defaultProfiles).includes(profile);
}

async function seedRepresentativeIdentityAccounts(
  services: ReturnType<typeof createIdentityServices>,
  context: ReturnType<typeof createIdentityBootstrapContext>,
) {
  for (const account of representativeAccounts) {
    await reconcileRepresentativeAccount(services, context, account);

    if (!(await rowExists(services.db, "identity_users", "user_id", account.userId))) {
      await services.users.commandHandler({
        streamId: `identity.user-${account.userId}`,
        command: {
          type: "CreateUser",
          userId: account.userId as UserId,
          displayName: account.name,
          primaryEmail: account.primaryEmail,
          givenName: account.givenName,
          familyName: account.familyName,
          primaryContactMethod: {
            contactMethodId: account.contactMethodId,
            type: "email",
            value: account.primaryEmail,
            verifiedAt: REPRESENTATIVE_SEEDED_AT,
          },
        },
        context,
      });
      await services.users.commandHandler({
        streamId: `identity.user-${account.userId}`,
        command: {
          type: "EnableAuthMethod",
          authMethod: "magic-link",
        },
        context,
      });
    }

    if (!(await rowExists(services.db, "identity_memberships", "membership_id", account.membershipId))) {
      await services.memberships.commandHandler({
        streamId: `identity.membership-${account.membershipId}`,
        command: {
          type: "GrantMembership",
          membershipId: account.membershipId as MembershipId,
          userId: account.userId as UserId,
          accountId: account.accountId as AccountId,
          roleKey: account.roleKey,
          assignmentAuthority: { type: "system" },
        },
        context,
      });
    }

    if (!(await rowExists(services.db, "identity_consents", "consent_id", account.consentId))) {
      await services.consents.commandHandler({
        streamId: `identity.consent-${account.consentId}`,
        command: {
          type: "RecordConsent",
          consentId: account.consentId as ConsentId,
          subjectType: "user",
          userId: account.userId as UserId,
          accountId: account.accountId as AccountId,
          policyKey: "terms-of-service",
          policyVersion: "v1",
          recordedAt: REPRESENTATIVE_SEEDED_AT,
        },
        context,
      });
    }

    if (
      !(await rowExists(services.db, "identity_shipping_addresses", "shipping_address_id", account.shippingAddressId))
    ) {
      await services.shippingAddresses.commandHandler({
        streamId: `identity.shipping-address-book-${account.accountId}`,
        command: {
          type: "AddShippingAddress",
          accountId: account.accountId as AccountId,
          shippingAddressId: account.shippingAddressId as ShippingAddressId,
          label: "Representative staging address",
          address: account.shippingAddress,
          makeDefault: true,
          addedAt: REPRESENTATIVE_SEEDED_AT,
        },
        context,
      });
    }
  }
}

async function reconcileRepresentativeAccount(
  services: ReturnType<typeof createIdentityServices>,
  context: ReturnType<typeof createIdentityBootstrapContext>,
  account: (typeof representativeAccounts)[number],
): Promise<void> {
  const existing = await services.accounts.getAccountState(account.accountId);
  if (!existing) {
    await services.accounts.commandHandler({
      streamId: `identity.account-${account.accountId}`,
      command: {
        type: "CreateAccount",
        accountId: account.accountId as AccountId,
        name: account.name,
        accountType: account.accountType,
        displayName: account.displayName,
      },
      context,
    });
    return;
  }

  const requestedProfile = {
    accountId: account.accountId,
    name: account.name,
    accountType: account.accountType,
    displayName: account.displayName,
  };
  const existingProfile = {
    accountId: existing.id,
    name: existing.name,
    accountType: existing.accountType,
    displayName: existing.displayName,
  };
  if (
    existingProfile.accountId !== requestedProfile.accountId ||
    existingProfile.name !== requestedProfile.name ||
    existingProfile.accountType !== requestedProfile.accountType ||
    existingProfile.displayName !== requestedProfile.displayName
  ) {
    throw new IdentityDomainError(
      `Representative Identity Account conflict for '${account.accountId}': existing committed profile ${JSON.stringify(existingProfile)} does not match requested deterministic profile ${JSON.stringify(requestedProfile)}. Resolve the conflicting Account stream before resuming representative seeding.`,
    );
  }
}

async function rowExists(
  db: ReturnType<typeof createIdentityServices>["db"],
  tableName: string,
  columnName: string,
  value: string,
): Promise<boolean> {
  try {
    const existing = await db.query(`SELECT 1 FROM ${tableName} WHERE ${columnName} = $1 LIMIT 1`, [value]);
    return existing.rows.length > 0;
  } catch {
    return false;
  }
}
