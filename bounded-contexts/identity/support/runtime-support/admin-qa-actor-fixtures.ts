import type { AccountId, ConsentId, MembershipId, UserId } from "@chase-sets/primitives/typed-ids";
import type { RoleKey } from "./common";
import { createIdentityBootstrapContext } from "./bootstrap-context";
import { ensureSeededConsentActivation, isSeededConsentRecordable } from "./seeded-consent-activation";
import type { IdentityServices } from "./services";

const ADMIN_QA_ACTOR_FIXTURES_SEEDED_AT = "2026-07-13T00:00:00.000Z";
const ADMIN_QA_ACTOR_FIXTURE_CONSENT_POLICY_KEY = "terms-of-service";
const ADMIN_QA_ACTOR_FIXTURE_CONSENT_VERSION = "v1";
const ADMIN_QA_ACTOR_FIXTURES_ACTIVATION_ACTOR_USER_ID = "usr_admin_qa_actor_fixtures";

export type AdminQaActorFixtureSignInHost = "/access/sign-in" | "/catalog/sign-in";

export type AdminQaActorFixtureCapability = "customer-submit" | "staff-view" | "staff-manage" | "staff-export";

export const ADMIN_QA_ACTOR_FIXTURE_CAPABILITIES: readonly AdminQaActorFixtureCapability[] = [
  "customer-submit",
  "staff-view",
  "staff-manage",
  "staff-export",
] as const;

export type AdminQaActorFixtureDefinition = Readonly<{
  actorAlias: string;
  roleKey: RoleKey;
  signInHost: AdminQaActorFixtureSignInHost;
  capabilities: readonly AdminQaActorFixtureCapability[];
  accountId: AccountId;
  userId: UserId;
  membershipId: MembershipId;
  consentId: ConsentId;
  accountName: string;
  displayName: string;
  primaryEmail: string;
  givenName: string;
  familyName: string;
}>;

export type AdminQaActorFixtureResult = Readonly<{
  actorAlias: string;
  roleKey: RoleKey;
  signInHost: AdminQaActorFixtureSignInHost;
  capabilities: readonly AdminQaActorFixtureCapability[];
  createdAccount: boolean;
  createdUser: boolean;
  createdMembership: boolean;
  createdConsent: boolean;
}>;

/**
 * Support-safe staging actor fixtures for the Admin Workflows Staging QA
 * actor matrix. Every alias maps 1:1 to a full role grant that the Identity
 * membership model can actually express today. Customer feedback submission
 * is an authenticated-subject capability, not an operator permission. Staff
 * feedback view/manage/export is platform-admin-only; ordinary account roles
 * deliberately have none of those operator capabilities. The Admin Shell
 * Smoke Matrix's single-permission partial-actor rows (`security.manage` only,
 * `memberships.view` only, etc.) are intentionally excluded: Identity only
 * grants whole roles (`ROLE_KEYS`), not scoped single-permission
 * memberships, so those rows stay local-only regression guardrails per
 * `docs/runbooks/admin-shell-smoke-matrix.md` until a scoped permission
 * grant primitive exists.
 */
export const ADMIN_QA_ACTOR_FIXTURES: readonly AdminQaActorFixtureDefinition[] = [
  {
    actorAlias: "admin-qa-platform-admin",
    roleKey: "platform-admin",
    signInHost: "/access/sign-in",
    capabilities: ["customer-submit", "staff-view", "staff-manage", "staff-export"],
    accountId: "acc_admin_qa_platform_admin" as AccountId,
    userId: "usr_admin_qa_platform_admin" as UserId,
    membershipId: "mbr_admin_qa_platform_admin" as MembershipId,
    consentId: "cns_admin_qa_platform_admin" as ConsentId,
    accountName: "Admin QA Platform Admin",
    displayName: "Admin QA Platform Admin",
    primaryEmail: "admin-qa-platform-admin@chasesets.test",
    givenName: "Admin QA",
    familyName: "Platform Admin",
  },
  {
    actorAlias: "admin-qa-owner",
    roleKey: "owner",
    signInHost: "/access/sign-in",
    capabilities: ["customer-submit"],
    accountId: "acc_admin_qa_owner" as AccountId,
    userId: "usr_admin_qa_owner" as UserId,
    membershipId: "mbr_admin_qa_owner" as MembershipId,
    consentId: "cns_admin_qa_owner" as ConsentId,
    accountName: "Admin QA Owner",
    displayName: "Admin QA Owner",
    primaryEmail: "admin-qa-owner@chasesets.test",
    givenName: "Admin QA",
    familyName: "Owner",
  },
  {
    actorAlias: "admin-qa-manager",
    roleKey: "manager",
    signInHost: "/access/sign-in",
    capabilities: ["customer-submit"],
    accountId: "acc_admin_qa_manager" as AccountId,
    userId: "usr_admin_qa_manager" as UserId,
    membershipId: "mbr_admin_qa_manager" as MembershipId,
    consentId: "cns_admin_qa_manager" as ConsentId,
    accountName: "Admin QA Manager",
    displayName: "Admin QA Manager",
    primaryEmail: "admin-qa-manager@chasesets.test",
    givenName: "Admin QA",
    familyName: "Manager",
  },
  {
    actorAlias: "admin-qa-fulfillment",
    roleKey: "fulfillment",
    signInHost: "/access/sign-in",
    capabilities: ["customer-submit"],
    accountId: "acc_admin_qa_fulfillment" as AccountId,
    userId: "usr_admin_qa_fulfillment" as UserId,
    membershipId: "mbr_admin_qa_fulfillment" as MembershipId,
    consentId: "cns_admin_qa_fulfillment" as ConsentId,
    accountName: "Admin QA Fulfillment",
    displayName: "Admin QA Fulfillment",
    primaryEmail: "admin-qa-fulfillment@chasesets.test",
    givenName: "Admin QA",
    familyName: "Fulfillment",
  },
  {
    actorAlias: "admin-qa-viewer",
    roleKey: "viewer",
    signInHost: "/access/sign-in",
    capabilities: ["customer-submit"],
    accountId: "acc_admin_qa_viewer" as AccountId,
    userId: "usr_admin_qa_viewer" as UserId,
    membershipId: "mbr_admin_qa_viewer" as MembershipId,
    consentId: "cns_admin_qa_viewer" as ConsentId,
    accountName: "Admin QA Viewer",
    displayName: "Admin QA Viewer",
    primaryEmail: "admin-qa-viewer@chasesets.test",
    givenName: "Admin QA",
    familyName: "Viewer",
  },
  {
    actorAlias: "admin-qa-catalog-admin",
    roleKey: "manager",
    signInHost: "/catalog/sign-in",
    capabilities: ["customer-submit"],
    accountId: "acc_admin_qa_catalog_admin" as AccountId,
    userId: "usr_admin_qa_catalog_admin" as UserId,
    membershipId: "mbr_admin_qa_catalog_admin" as MembershipId,
    consentId: "cns_admin_qa_catalog_admin" as ConsentId,
    accountName: "Admin QA Catalog Admin",
    displayName: "Admin QA Catalog Admin",
    primaryEmail: "admin-qa-catalog-admin@chasesets.test",
    givenName: "Admin QA",
    familyName: "Catalog Admin",
  },
] as const;

/**
 * Idempotently provisions the support-safe admin-qa-* staging actor
 * fixtures. Every identity is magic-link only (no password to leak), stable
 * across reruns, and skipped when it already exists so reruns after a full
 * staging platform reset stay cheap. Returns only support-safe per-alias
 * outcome flags; callers must not log the underlying account, user, or
 * membership ids.
 */
export async function provisionAdminQaActorFixtures(
  services: IdentityServices,
): Promise<readonly AdminQaActorFixtureResult[]> {
  const context = createIdentityBootstrapContext();
  const results: AdminQaActorFixtureResult[] = [];

  // These fixtures record a Consent for a Consent Bundle member, and that is
  // only admitted while the member's compiled artifact is consent-activatable
  // AND its activation authority reports the exact version active. Provisioning
  // therefore publishes and activates the version it is about to record
  // against, explicitly, rather than reaching around the admission rule -- and
  // does neither while the artifact is not consent-activatable, which is the
  // shipped state of every policy at this head.
  await ensureSeededConsentActivation(services, context, {
    policyKey: ADMIN_QA_ACTOR_FIXTURE_CONSENT_POLICY_KEY,
    version: ADMIN_QA_ACTOR_FIXTURE_CONSENT_VERSION,
    actorUserId: ADMIN_QA_ACTOR_FIXTURES_ACTIVATION_ACTOR_USER_ID,
    activatedAt: ADMIN_QA_ACTOR_FIXTURES_SEEDED_AT,
  });

  for (const fixture of ADMIN_QA_ACTOR_FIXTURES) {
    results.push(await provisionAdminQaActorFixture(services, context, fixture));
  }

  return results;
}

async function provisionAdminQaActorFixture(
  services: IdentityServices,
  context: ReturnType<typeof createIdentityBootstrapContext>,
  fixture: AdminQaActorFixtureDefinition,
): Promise<AdminQaActorFixtureResult> {
  let createdAccount = false;
  let createdUser = false;
  let createdMembership = false;
  let createdConsent = false;

  if (!(await rowExists(services.db, "identity_accounts", "account_id", fixture.accountId))) {
    await services.accounts.commandHandler({
      streamId: `identity.account-${fixture.accountId}`,
      command: {
        type: "CreateAccount",
        accountId: fixture.accountId,
        name: fixture.accountName,
        accountType: "business",
        displayName: fixture.accountName,
      },
      context,
    });
    createdAccount = true;
  }

  if (!(await rowExists(services.db, "identity_users", "user_id", fixture.userId))) {
    await services.users.commandHandler({
      streamId: `identity.user-${fixture.userId}`,
      command: {
        type: "CreateUser",
        userId: fixture.userId,
        displayName: fixture.displayName,
        primaryEmail: fixture.primaryEmail,
        givenName: fixture.givenName,
        familyName: fixture.familyName,
        primaryContactMethod: {
          contactMethodId: `ctm_${fixture.userId.slice(4)}_email`,
          type: "email",
          value: fixture.primaryEmail,
          verifiedAt: ADMIN_QA_ACTOR_FIXTURES_SEEDED_AT,
        },
      },
      context,
    });
    await services.users.commandHandler({
      streamId: `identity.user-${fixture.userId}`,
      command: {
        type: "EnableAuthMethod",
        authMethod: "magic-link",
      },
      context,
    });
    createdUser = true;
  }

  if (!(await rowExists(services.db, "identity_memberships", "membership_id", fixture.membershipId))) {
    await services.memberships.commandHandler({
      streamId: `identity.membership-${fixture.membershipId}`,
      command: {
        type: "GrantMembership",
        membershipId: fixture.membershipId,
        userId: fixture.userId,
        accountId: fixture.accountId,
        roleKey: fixture.roleKey,
        assignmentAuthority: fixture.roleKey === "platform-admin" ? { type: "platform-bootstrap" } : { type: "system" },
      },
      context,
    });
    createdMembership = true;
  }

  if (
    isSeededConsentRecordable(ADMIN_QA_ACTOR_FIXTURE_CONSENT_POLICY_KEY, ADMIN_QA_ACTOR_FIXTURE_CONSENT_VERSION) &&
    !(await rowExists(services.db, "identity_consents", "consent_id", fixture.consentId))
  ) {
    await services.consents.commandHandler({
      streamId: `identity.consent-${fixture.consentId}`,
      command: {
        type: "RecordConsent",
        consentId: fixture.consentId,
        subjectType: "user",
        userId: fixture.userId,
        accountId: fixture.accountId,
        policyKey: ADMIN_QA_ACTOR_FIXTURE_CONSENT_POLICY_KEY,
        policyVersion: ADMIN_QA_ACTOR_FIXTURE_CONSENT_VERSION,
        recordedAt: ADMIN_QA_ACTOR_FIXTURES_SEEDED_AT,
      },
      context,
    });
    createdConsent = true;
  }

  return {
    actorAlias: fixture.actorAlias,
    roleKey: fixture.roleKey,
    signInHost: fixture.signInHost,
    capabilities: fixture.capabilities,
    createdAccount,
    createdUser,
    createdMembership,
    createdConsent,
  };
}

async function rowExists(
  db: IdentityServices["db"],
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
