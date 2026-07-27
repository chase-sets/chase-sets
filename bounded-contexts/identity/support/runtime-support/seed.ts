import type {
  BcSeedAggregateStateReport,
  BcSeedOptions,
  EnvironmentDataProfile,
} from "@chase-sets/bounded-context-module";
import {
  createSeedAggregateReconciler,
  reconcileSeedAggregates,
  type SeedAggregateReconciler,
} from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { isDeepStrictEqual } from "node:util";
import { identitySeedIds } from "../seed-support/ids";
import { createIdentityServices } from "./services";
import { createIdentityBootstrapContext } from "./bootstrap-context";
import { provisionAdminQaActorFixtures } from "./admin-qa-actor-fixtures";
import { ensureSeededConsentActivation } from "./seeded-consent-activation";
import type { AccountId, ConsentId, MembershipId, ShippingAddressId, UserId } from "@chase-sets/primitives/typed-ids";
import {
  decideAccount,
  evolveAccount,
  initialAccountState,
  type AccountCommand,
  type AccountEvent,
  type AccountState,
} from "../../features/accounts/domain/domain";
import {
  decideApiKey,
  evolveApiKey,
  initialApiKeyState,
  type ApiKeyCommand,
  type ApiKeyEvent,
  type ApiKeyState,
} from "../../features/api-keys/domain/domain";
import {
  decideConsent,
  evolveConsent,
  initialConsentState,
  type ConsentCommand,
  type ConsentEvent,
  type ConsentState,
} from "../../features/consents/domain/domain";
import {
  decideInvitation,
  evolveInvitation,
  initialInvitationState,
  type InvitationCommand,
  type InvitationEvent,
  type InvitationState,
} from "../../features/invitations/domain/domain";
import {
  decideMembership,
  evolveMembership,
  initialMembershipState,
  type MembershipCommand,
  type MembershipEvent,
  type MembershipState,
} from "../../features/memberships/domain/domain";
import {
  decideUser,
  evolveUser,
  initialUserState,
  type UserCommand,
  type UserEvent,
  type UserState,
} from "../../features/users/domain/domain";
import {
  decideShippingAddressBook,
  evolveShippingAddressBook,
  initialShippingAddressBookState,
  normalizeShippingAddressSnapshot,
  type ShippingAddressBookState,
  type ShippingAddressCommand,
  type ShippingAddressEvent,
} from "../../features/shipping-addresses/domain/domain";
import { IdentityDomainError, normalizeEmail, normalizeLabel } from "./common";

const DEMO_CONTACT_METHOD_ID = "ctm_seed_demo_sms";
const DEMO_PRIMARY_EMAIL_CONTACT_METHOD_ID = "ctm_seed_demo_email";
const DEMO_PASSKEY_ID = "crd_seed_demo_passkey";
const SUPPORT_CONTACT_METHOD_ID = "ctm_seed_support_email";
const DEMO_PRIMARY_KEY_PREFIX = "sk_seed_demo_primary";
const DEMO_ROTATED_KEY_PREFIX = "sk_seed_demo_rotated";
const REPRESENTATIVE_SEEDED_AT = "2026-05-27T00:00:00.000Z";
const SEEDED_CONSENT_POLICY_KEY = "terms-of-service";
const SEEDED_CONSENT_POLICY_VERSION = "v1";
const SEEDED_CONSENT_ACTIVATED_AT = "2026-03-03T00:00:00.000Z";
const SEEDED_CONSENT_ACTIVATION_ACTOR_USER_ID = "usr_identity_seed_bootstrap";
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

const IDENTITY_BOOTSTRAP_LABEL = "Identity seed bootstrap";

const additionalMarketAccounts = [
  {
    seed: identitySeedIds.valueTrader,
    name: "Value Trader",
    accountType: "personal",
    displayName: "Binder Builder",
    primaryEmail: "value-trader@chasesets.test",
    givenName: "Value",
    familyName: "Trader",
  },
  {
    seed: identitySeedIds.highRollerTrader,
    name: "High Roller Trader",
    accountType: "business",
    displayName: "Top Loader Capital",
    primaryEmail: "high-roller@chasesets.test",
    givenName: "High",
    familyName: "Roller",
  },
  {
    seed: identitySeedIds.cardVault,
    name: "Card Vault",
    accountType: "business",
    displayName: "Card Vault",
    primaryEmail: "card-vault@chasesets.test",
    givenName: "Card",
    familyName: "Vault",
  },
  {
    seed: identitySeedIds.sealedStockroom,
    name: "Sealed Stockroom",
    accountType: "business",
    displayName: "Pack Runners",
    primaryEmail: "sealed-stockroom@chasesets.test",
    givenName: "Pack",
    familyName: "Runner",
  },
] as const;

type IdentityServices = ReturnType<typeof createIdentityServices>;
type IdentityBootstrapContext = ReturnType<typeof createIdentityBootstrapContext>;

/**
 * Every base aggregate the scenario Identity seed authors, bound to its own
 * `identity.*` event stream.
 *
 * `identity_accounts` is UNLOGGED, so PostgreSQL truncates it on crash
 * recovery while the logged streams survive. The projection-sourced guard this
 * replaced then read zero rows and replayed `CreateAccount` into an existing
 * aggregate. Each aggregate now resumes from the command sequence its own
 * stream is missing, so a partially seeded account, user, membership,
 * invitation, or API key is repaired rather than re-authored or mistaken for
 * complete.
 */
function buildScenarioIdentityReconcilers(
  services: IdentityServices,
  context: IdentityBootstrapContext,
): readonly SeedAggregateReconciler[] {
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

  const accountReconciler = (id: string, key: string, steps: readonly AccountCommand[]) =>
    createSeedAggregateReconciler<AccountState, AccountCommand, AccountEvent>({
      db: services.db,
      contextName: "identity",
      bootstrapLabel: IDENTITY_BOOTSTRAP_LABEL,
      aggregateName: "Account",
      id,
      key,
      streamId: `identity.account-${id}`,
      initialState: initialAccountState,
      decide: decideAccount,
      evolve: evolveAccount,
      steps,
      send: (streamId, command) => services.accounts.commandHandler({ streamId, command, context }),
    });

  const userReconciler = (id: string, key: string, steps: readonly UserCommand[]) =>
    createSeedAggregateReconciler<UserState, UserCommand, UserEvent>({
      db: services.db,
      contextName: "identity",
      bootstrapLabel: IDENTITY_BOOTSTRAP_LABEL,
      aggregateName: "User",
      id,
      key,
      streamId: `identity.user-${id}`,
      initialState: initialUserState,
      decide: decideUser,
      evolve: evolveUser,
      steps,
      send: (streamId, command) => services.users.commandHandler({ streamId, command, context }),
    });

  const membershipReconciler = (id: string, key: string, steps: readonly MembershipCommand[]) =>
    createSeedAggregateReconciler<MembershipState, MembershipCommand, MembershipEvent>({
      db: services.db,
      contextName: "identity",
      bootstrapLabel: IDENTITY_BOOTSTRAP_LABEL,
      aggregateName: "Membership",
      id,
      key,
      streamId: `identity.membership-${id}`,
      initialState: initialMembershipState,
      decide: decideMembership,
      evolve: evolveMembership,
      steps,
      send: (streamId, command) => services.memberships.commandHandler({ streamId, command, context }),
    });

  const consentReconciler = (id: string, key: string, steps: readonly ConsentCommand[]) =>
    createSeedAggregateReconciler<ConsentState, ConsentCommand, ConsentEvent>({
      db: services.db,
      contextName: "identity",
      bootstrapLabel: IDENTITY_BOOTSTRAP_LABEL,
      aggregateName: "Consent",
      id,
      key,
      streamId: `identity.consent-${id}`,
      initialState: initialConsentState,
      decide: decideConsent,
      evolve: evolveConsent,
      steps,
      send: (streamId, command) => services.consents.commandHandler({ streamId, command, context }),
    });

  const invitationReconciler = (id: string, key: string, steps: readonly InvitationCommand[]) =>
    createSeedAggregateReconciler<InvitationState, InvitationCommand, InvitationEvent>({
      db: services.db,
      contextName: "identity",
      bootstrapLabel: IDENTITY_BOOTSTRAP_LABEL,
      aggregateName: "Invitation",
      id,
      key,
      streamId: `identity.invitation-${id}`,
      initialState: initialInvitationState,
      decide: decideInvitation,
      evolve: evolveInvitation,
      steps,
      send: (streamId, command) => services.invitations.commandHandler({ streamId, command, context }),
    });

  const apiKeyReconciler = (id: string, key: string, steps: readonly ApiKeyCommand[]) =>
    createSeedAggregateReconciler<ApiKeyState, ApiKeyCommand, ApiKeyEvent>({
      db: services.db,
      contextName: "identity",
      bootstrapLabel: IDENTITY_BOOTSTRAP_LABEL,
      aggregateName: "API Key",
      id,
      key,
      streamId: `identity.api-key-${id}`,
      initialState: initialApiKeyState,
      decide: decideApiKey,
      evolve: evolveApiKey,
      steps,
      send: (streamId, command) => services.apiKeys.commandHandler({ streamId, command, context }),
    });

  const shippingAddressBookReconciler = (accountId: string, key: string, steps: readonly ShippingAddressCommand[]) =>
    createSeedAggregateReconciler<ShippingAddressBookState, ShippingAddressCommand, ShippingAddressEvent>({
      db: services.db,
      contextName: "identity",
      bootstrapLabel: IDENTITY_BOOTSTRAP_LABEL,
      aggregateName: "Shipping Address Book",
      id: accountId,
      key,
      streamId: `identity.shipping-address-book-${accountId}`,
      initialState: initialShippingAddressBookState,
      decide: decideShippingAddressBook,
      evolve: evolveShippingAddressBook,
      steps,
      send: (streamId, command) => services.shippingAddresses.commandHandler({ streamId, command, context }),
    });

  const trustedSellerBadgeStep = (accountId: string): readonly AccountCommand[] =>
    scenarioTrustedSellerAccountIds.some((candidate) => String(candidate) === String(accountId))
      ? [{ type: "AssignAccountBadge", badgeKey: "trusted-seller" }]
      : [];

  return [
    accountReconciler(demo.accountId, "Demo Account", [
      {
        type: "CreateAccount",
        accountId: demo.accountId,
        name: "Demo Account",
        accountType: "business",
        displayName: "Chase Sets",
      },
      ...trustedSellerBadgeStep(demo.accountId),
    ]),
    accountReconciler(collector.accountId, "Demo Collector", [
      {
        type: "CreateAccount",
        accountId: collector.accountId,
        name: "Demo Collector",
        accountType: "personal",
        displayName: "Collector Zero",
      },
      ...trustedSellerBadgeStep(collector.accountId),
    ]),
    accountReconciler(support.accountId, "Support Ops", [
      {
        type: "CreateAccount",
        accountId: support.accountId,
        name: "Support Ops",
        accountType: "business",
        displayName: "Support Ops",
      },
      ...trustedSellerBadgeStep(support.accountId),
    ]),
    accountReconciler(suspended.accountId, "Dormant Account", [
      {
        type: "CreateAccount",
        accountId: suspended.accountId,
        name: "Dormant Account",
        accountType: "business",
        displayName: "Dormant Account",
      },
      { type: "SuspendAccount" },
    ]),
    ...additionalMarketAccounts.map((persona) =>
      accountReconciler(persona.seed.accountId, persona.name, [
        {
          type: "CreateAccount",
          accountId: persona.seed.accountId,
          name: persona.name,
          accountType: persona.accountType,
          displayName: persona.displayName,
        },
        ...trustedSellerBadgeStep(persona.seed.accountId),
      ]),
    ),

    shippingAddressBookReconciler(demo.accountId, "Office receiving", [
      {
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
    ]),
    shippingAddressBookReconciler(collector.accountId, "Home", [
      {
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
    ]),

    userReconciler(demo.userId, "demo@chasesets.test", [
      {
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
      {
        type: "AddContactMethod",
        contactMethodId: DEMO_CONTACT_METHOD_ID,
        contactMethodType: "phone",
        value: "312 555 0101",
      },
      {
        type: "VerifyContactMethod",
        contactMethodId: DEMO_CONTACT_METHOD_ID,
        verifiedAt: isoDate("2026-03-01T09:00:00.000Z"),
      },
      { type: "EnableAuthMethod", authMethod: "password" },
      { type: "EnableAuthMethod", authMethod: "passkey" },
      { type: "AttachPasswordCredential", credentialId: demo.credentialId },
      { type: "RegisterPasskeyCredential", credentialId: DEMO_PASSKEY_ID },
    ]),
    userReconciler(collector.userId, "collector@chasesets.test", [
      {
        type: "CreateUser",
        userId: collector.userId,
        displayName: "Demo Collector",
        primaryEmail: "collector@chasesets.test",
        givenName: "Demo",
        familyName: "Collector",
      },
      { type: "EnableAuthMethod", authMethod: "password" },
      { type: "AttachPasswordCredential", credentialId: collector.credentialId },
    ]),
    userReconciler(support.userId, "support@chasesets.test", [
      {
        type: "CreateUser",
        userId: support.userId,
        displayName: "Support User",
        primaryEmail: "support@chasesets.test",
        givenName: "Support",
        familyName: "User",
      },
      {
        type: "AddContactMethod",
        contactMethodId: SUPPORT_CONTACT_METHOD_ID,
        contactMethodType: "email",
        value: "support+alerts@chasesets.test",
      },
      {
        type: "VerifyContactMethod",
        contactMethodId: SUPPORT_CONTACT_METHOD_ID,
        verifiedAt: isoDate("2026-03-02T09:00:00.000Z"),
      },
      { type: "EnableAuthMethod", authMethod: "magic-link" },
    ]),
    userReconciler(suspended.userId, "suspended@chasesets.test", [
      {
        type: "CreateUser",
        userId: suspended.userId,
        displayName: "Suspended User",
        primaryEmail: "suspended@chasesets.test",
        givenName: "Suspended",
        familyName: "User",
      },
      { type: "SuspendUser" },
    ]),
    ...additionalMarketAccounts.map((persona) =>
      userReconciler(persona.seed.userId, persona.primaryEmail, [
        {
          type: "CreateUser",
          userId: persona.seed.userId,
          displayName: persona.name,
          primaryEmail: persona.primaryEmail,
          givenName: persona.givenName,
          familyName: persona.familyName,
        },
        { type: "EnableAuthMethod", authMethod: "password" },
        { type: "AttachPasswordCredential", credentialId: persona.seed.credentialId },
      ]),
    ),

    membershipReconciler(demo.membershipId, "Demo Account owner", [
      {
        type: "GrantMembership",
        membershipId: demo.membershipId,
        userId: demo.userId,
        accountId: demo.accountId,
        roleKey: "owner",
        assignmentAuthority: { type: "system" },
      },
    ]),
    membershipReconciler(collector.membershipId, "Demo Collector owner", [
      {
        type: "GrantMembership",
        membershipId: collector.membershipId,
        userId: collector.userId,
        accountId: collector.accountId,
        roleKey: "owner",
        assignmentAuthority: { type: "system" },
      },
    ]),
    membershipReconciler(support.membershipId, "Support Ops manager", [
      {
        type: "GrantMembership",
        membershipId: support.membershipId,
        userId: support.userId,
        accountId: demo.accountId,
        roleKey: "viewer",
        assignmentAuthority: { type: "system" },
      },
      { type: "ChangeMembershipRole", roleKey: "manager", assignmentAuthority: { type: "system" } },
      { type: "RevokeMembership" },
      { type: "ReinstateMembership" },
    ]),
    membershipReconciler(suspended.membershipId, "Dormant Account owner", [
      {
        type: "GrantMembership",
        membershipId: suspended.membershipId,
        userId: suspended.userId,
        accountId: suspended.accountId,
        roleKey: "owner",
        assignmentAuthority: { type: "system" },
      },
    ]),
    ...additionalMarketAccounts.map((persona) =>
      membershipReconciler(persona.seed.membershipId, `${persona.name} owner`, [
        {
          type: "GrantMembership",
          membershipId: persona.seed.membershipId,
          userId: persona.seed.userId,
          accountId: persona.seed.accountId,
          roleKey: "owner",
          assignmentAuthority: { type: "system" },
        },
      ]),
    ),

    ...[demo, collector, valueTrader, highRollerTrader, cardVault, sealedStockroom].map((consent) =>
      consentReconciler(consent.consentId, `terms-of-service ${consent.userId}`, [
        {
          type: "RecordConsent",
          consentId: consent.consentId,
          subjectType: "user",
          userId: consent.userId,
          accountId: consent.accountId,
          policyKey: SEEDED_CONSENT_POLICY_KEY,
          policyVersion: SEEDED_CONSENT_POLICY_VERSION,
          recordedAt: isoDate("2026-03-03T12:00:00.000Z"),
        },
      ]),
    ),

    invitationReconciler(support.invitationId, "support@chasesets.test", [
      {
        type: "CreateInvitation",
        invitationId: support.invitationId,
        accountId: demo.accountId,
        email: "support@chasesets.test",
        roleKey: "manager",
        expiresAt: isoDate("2026-05-01T00:00:00.000Z"),
        assignmentAuthority: { type: "system" },
      },
      {
        type: "IssueInvitationAcceptanceToken",
        tokenHash: "seeded-support-invitation-token",
        expiresAt: isoDate("2026-04-01T00:00:00.000Z"),
      },
      {
        type: "AcceptInvitation",
        userId: support.userId,
        acceptanceTokenHash: "seeded-support-invitation-token",
        acceptedAt: isoDate("2026-03-03T12:00:00.000Z"),
      },
    ]),
    invitationReconciler(invitations.declined, "declined@chasesets.test", [
      {
        type: "CreateInvitation",
        invitationId: invitations.declined,
        accountId: demo.accountId,
        email: "declined@chasesets.test",
        roleKey: "viewer",
        expiresAt: isoDate("2026-05-03T00:00:00.000Z"),
        assignmentAuthority: { type: "system" },
      },
      { type: "DeclineInvitation" },
    ]),
    invitationReconciler(invitations.cancelled, "cancelled@chasesets.test", [
      {
        type: "CreateInvitation",
        invitationId: invitations.cancelled,
        accountId: demo.accountId,
        email: "cancelled@chasesets.test",
        roleKey: "viewer",
        expiresAt: isoDate("2026-05-05T00:00:00.000Z"),
        assignmentAuthority: { type: "system" },
      },
      { type: "CancelInvitation" },
    ]),
    invitationReconciler(invitations.expired, "expired@chasesets.test", [
      {
        type: "CreateInvitation",
        invitationId: invitations.expired,
        accountId: demo.accountId,
        email: "expired@chasesets.test",
        roleKey: "viewer",
        expiresAt: isoDate("2026-03-04T00:00:00.000Z"),
        assignmentAuthority: { type: "system" },
      },
      { type: "ExpireInvitation" },
    ]),

    apiKeyReconciler(demo.apiKeyId, DEMO_PRIMARY_KEY_PREFIX, [
      {
        type: "CreateApiKey",
        apiKeyId: demo.apiKeyId,
        userId: demo.userId,
        name: "Primary integration",
        keyPrefix: DEMO_PRIMARY_KEY_PREFIX,
      },
      { type: "RecordApiKeyUse", usedAt: isoDate("2026-03-06T00:00:00.000Z") },
    ]),
    apiKeyReconciler(apiKeys.rotatedRevoked, DEMO_ROTATED_KEY_PREFIX, [
      {
        type: "CreateApiKey",
        apiKeyId: apiKeys.rotatedRevoked,
        userId: demo.userId,
        name: "Legacy automation key",
        keyPrefix: "sk_seed_demo_legacy",
      },
      { type: "RotateApiKey", keyPrefix: DEMO_ROTATED_KEY_PREFIX },
      { type: "RevokeApiKey" },
    ]),
  ];
}

/**
 * Reports the Identity seed's base aggregate state from the authoritative
 * `identity.*` streams. Returns an empty inventory when the scenario profile is
 * not enabled, because no scenario aggregate is authored in that case.
 */
export async function inspectIdentitySeedState(
  pool: PgTransactionalPool,
  options?: BcSeedOptions,
): Promise<readonly BcSeedAggregateStateReport[]> {
  if (!profileEnabled(options, "scenario-seed")) {
    return [];
  }
  const services = createIdentityServices(pool);
  return reconcileSeedAggregates(buildScenarioIdentityReconcilers(services, createIdentityBootstrapContext()), false);
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

  // Both the scenario and representative profiles author Consent facts for a
  // Consent Bundle member, and recording one is only admitted while that
  // member's activation authority reports the exact version active. The seed
  // therefore does what an operator would: publish the value and activate the
  // key before authoring anything against it. There is no seed-only bypass of
  // the admission rule.
  if (shouldSeedScenario || shouldSeedRepresentative) {
    await ensureSeededConsentActivation(services, context, {
      policyKey: SEEDED_CONSENT_POLICY_KEY,
      version: SEEDED_CONSENT_POLICY_VERSION,
      actorUserId: SEEDED_CONSENT_ACTIVATION_ACTOR_USER_ID,
      activatedAt: SEEDED_CONSENT_ACTIVATED_AT,
    });
  }

  if (shouldSeedScenario) {
    await reconcileSeedAggregates(buildScenarioIdentityReconcilers(services, context), true);
  }
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
    await reconcileRepresentativeUser(services, context, account);
    await reconcileRepresentativeMembership(services, context, account);
    await reconcileRepresentativeConsent(services, context, account);
    await reconcileRepresentativeShippingAddress(services, context, account);
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
  assertMatchingRepresentativeProfile("Account", account.accountId, existingProfile, requestedProfile);
}

async function reconcileRepresentativeUser(
  services: ReturnType<typeof createIdentityServices>,
  context: ReturnType<typeof createIdentityBootstrapContext>,
  account: (typeof representativeAccounts)[number],
): Promise<void> {
  const existing = await services.users.getUserState(account.userId);
  const requestedProfile = {
    userId: account.userId,
    displayName: normalizeLabel(account.name),
    givenName: normalizeLabel(account.givenName),
    familyName: normalizeLabel(account.familyName),
    primaryEmail: normalizeEmail(account.primaryEmail),
    primaryContactMethod: {
      contactMethodId: account.contactMethodId,
      type: "email",
      value: normalizeEmail(account.primaryEmail),
      verifiedAt: REPRESENTATIVE_SEEDED_AT,
    },
    status: "active",
  } as const;

  if (!existing) {
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
  } else {
    const existingProfile = {
      userId: existing.id,
      displayName: existing.displayName,
      givenName: existing.givenName,
      familyName: existing.familyName,
      primaryEmail: existing.primaryEmail,
      primaryContactMethod:
        existing.contactMethods.find((method) => method.contactMethodId === account.contactMethodId) ?? null,
      status: existing.status,
    };
    assertMatchingRepresentativeProfile("User", account.userId, existingProfile, requestedProfile);
  }

  await services.users.commandHandler({
    streamId: `identity.user-${account.userId}`,
    command: {
      type: "EnableAuthMethod",
      authMethod: "magic-link",
    },
    context,
  });
}

async function reconcileRepresentativeMembership(
  services: ReturnType<typeof createIdentityServices>,
  context: ReturnType<typeof createIdentityBootstrapContext>,
  account: (typeof representativeAccounts)[number],
): Promise<void> {
  const existing = await services.memberships.getMembershipState(account.membershipId);
  if (!existing) {
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
    return;
  }

  const requestedProfile = {
    membershipId: account.membershipId,
    userId: account.userId,
    accountId: account.accountId,
    roleKey: account.roleKey,
    status: "active",
  } as const;
  const existingProfile = {
    membershipId: existing.id,
    userId: existing.userId,
    accountId: existing.accountId,
    roleKey: existing.roleKey,
    status: existing.status,
  };
  assertMatchingRepresentativeProfile("Membership", account.membershipId, existingProfile, requestedProfile);
}

async function reconcileRepresentativeConsent(
  services: ReturnType<typeof createIdentityServices>,
  context: ReturnType<typeof createIdentityBootstrapContext>,
  account: (typeof representativeAccounts)[number],
): Promise<void> {
  const existing = await services.consents.getConsentState(account.consentId);
  if (!existing) {
    await services.consents.commandHandler({
      streamId: `identity.consent-${account.consentId}`,
      command: {
        type: "RecordConsent",
        consentId: account.consentId as ConsentId,
        subjectType: "user",
        userId: account.userId as UserId,
        accountId: account.accountId as AccountId,
        policyKey: SEEDED_CONSENT_POLICY_KEY,
        policyVersion: SEEDED_CONSENT_POLICY_VERSION,
        recordedAt: REPRESENTATIVE_SEEDED_AT,
      },
      context,
    });
    return;
  }

  const requestedProfile = {
    consentId: account.consentId,
    subjectType: "user",
    userId: account.userId,
    accountId: account.accountId,
    policyKey: SEEDED_CONSENT_POLICY_KEY,
    policyVersion: SEEDED_CONSENT_POLICY_VERSION,
    recordedAt: REPRESENTATIVE_SEEDED_AT,
    status: "recorded",
  } as const;
  const existingProfile = {
    consentId: existing.id,
    subjectType: existing.subjectType,
    userId: existing.userId,
    accountId: existing.accountId,
    policyKey: existing.policyKey,
    policyVersion: existing.policyVersion,
    recordedAt: existing.recordedAt,
    status: existing.status,
  };
  assertMatchingRepresentativeProfile("Consent", account.consentId, existingProfile, requestedProfile);
}

async function reconcileRepresentativeShippingAddress(
  services: ReturnType<typeof createIdentityServices>,
  context: ReturnType<typeof createIdentityBootstrapContext>,
  account: (typeof representativeAccounts)[number],
): Promise<void> {
  const existingBook = await services.shippingAddresses.getShippingAddressBookState(account.accountId);
  const existing = existingBook?.addresses.find((address) => address.shippingAddressId === account.shippingAddressId);
  if (!existing) {
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
    return;
  }

  const requestedProfile = {
    accountId: account.accountId,
    shippingAddressId: account.shippingAddressId,
    label: "Representative staging address",
    ...normalizeShippingAddressSnapshot(account.shippingAddress),
    isDefault: true,
    isArchived: false,
    createdAt: REPRESENTATIVE_SEEDED_AT,
    updatedAt: REPRESENTATIVE_SEEDED_AT,
  };
  const existingProfile = {
    accountId: existingBook?.accountId ?? null,
    shippingAddressId: existing.shippingAddressId,
    label: existing.label,
    name: existing.name,
    company: existing.company,
    line1: existing.line1,
    line2: existing.line2,
    city: existing.city,
    state: existing.state,
    postalCode: existing.postalCode,
    country: existing.country,
    phone: existing.phone,
    email: existing.email,
    verification: existing.verification ?? null,
    isDefault: existing.isDefault,
    isArchived: existing.isArchived,
    createdAt: existing.createdAt,
    updatedAt: existing.updatedAt,
  };
  assertMatchingRepresentativeProfile("Shipping Address", account.shippingAddressId, existingProfile, requestedProfile);
}

function assertMatchingRepresentativeProfile(
  aggregateName: string,
  aggregateId: string,
  existingProfile: object,
  requestedProfile: object,
): void {
  if (!isDeepStrictEqual(existingProfile, requestedProfile)) {
    throw new IdentityDomainError(
      `Representative Identity ${aggregateName} conflict for '${aggregateId}': existing committed profile ${JSON.stringify(existingProfile)} does not match requested deterministic profile ${JSON.stringify(requestedProfile)}. Resolve the conflicting ${aggregateName} stream before resuming representative seeding.`,
    );
  }
}
