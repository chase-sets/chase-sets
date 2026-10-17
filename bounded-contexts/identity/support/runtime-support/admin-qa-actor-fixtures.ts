import type { AccountId, ConsentId, MembershipId, UserId } from "@chase-sets/primitives/typed-ids";
import type { RoleKey } from "./common";
import { createIdentityBootstrapContext } from "./bootstrap-context";
import type { IdentityServices } from "./services";
import { authorizeConsentForProvisioning } from "../../features/consents/domain/consent-recording-authorization";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";

const ADMIN_QA_ACTOR_FIXTURES_SEEDED_AT = "2026-07-13T00:00:00.000Z";
export type AdminQaActorFixtureSignInHost = "/access/sign-in" | "/catalog/sign-in";
export type AdminQaActorFixtureCapability = "customer-submit" | "staff-view" | "staff-manage" | "staff-export";
export const ADMIN_QA_ACTOR_FIXTURE_CAPABILITIES: readonly AdminQaActorFixtureCapability[] = [
  "customer-submit",
  "staff-view",
  "staff-manage",
  "staff-export",
] as const;

/** Contacts are composition inputs, never fixture definition data. */
export type AdminQaActorFixtureContacts = Readonly<{
  ADMIN_QA_PLATFORM_ADMIN_EMAIL: string;
  ADMIN_QA_OWNER_EMAIL: string;
  ADMIN_QA_MANAGER_EMAIL: string;
  ADMIN_QA_FULFILLMENT_EMAIL: string;
  ADMIN_QA_VIEWER_EMAIL: string;
  ADMIN_QA_CATALOG_ADMIN_EMAIL: string;
}>;

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
  givenName: string;
  familyName: string;
}>;
export type AdminQaActorFixtureOutcome = "created" | "reconciled" | "steady" | "conflict" | "error";
export type AdminQaActorFixtureResult = Readonly<{
  actorAlias: string;
  roleKey: RoleKey;
  signInHost: AdminQaActorFixtureSignInHost;
  capabilities: readonly AdminQaActorFixtureCapability[];
  outcome?: AdminQaActorFixtureOutcome;
  createdAccount: boolean;
  createdUser: boolean;
  createdMembership: boolean;
  createdConsent?: boolean;
}>;

const makeFixture = (
  actorAlias: string,
  roleKey: RoleKey,
  signInHost: AdminQaActorFixtureSignInHost,
  accountName: string,
  givenName: string,
  familyName: string,
  capabilities: readonly AdminQaActorFixtureCapability[] = ["customer-submit"],
): AdminQaActorFixtureDefinition => ({
  actorAlias,
  roleKey,
  signInHost,
  capabilities,
  accountId: `acc_${actorAlias.replaceAll("-", "_")}` as AccountId,
  userId: `usr_${actorAlias.replaceAll("-", "_")}` as UserId,
  membershipId: `mbr_${actorAlias.replaceAll("-", "_")}` as MembershipId,
  consentId: `cns_${actorAlias.replaceAll("-", "_")}` as ConsentId,
  accountName,
  displayName: accountName,
  givenName,
  familyName,
});

export const ADMIN_QA_ACTOR_FIXTURES: readonly AdminQaActorFixtureDefinition[] = [
  makeFixture(
    "admin-qa-platform-admin",
    "platform-admin",
    "/access/sign-in",
    "Admin QA Platform Admin",
    "Admin QA",
    "Platform Admin",
    ["customer-submit", "staff-view", "staff-manage", "staff-export"],
  ),
  makeFixture("admin-qa-owner", "owner", "/access/sign-in", "Admin QA Owner", "Admin QA", "Owner"),
  makeFixture("admin-qa-manager", "manager", "/access/sign-in", "Admin QA Manager", "Admin QA", "Manager"),
  makeFixture(
    "admin-qa-fulfillment",
    "fulfillment",
    "/access/sign-in",
    "Admin QA Fulfillment",
    "Admin QA",
    "Fulfillment",
  ),
  makeFixture("admin-qa-viewer", "viewer", "/access/sign-in", "Admin QA Viewer Primary", "Admin QA", "Viewer"),
  makeFixture(
    "admin-qa-catalog-admin",
    "manager",
    "/catalog/sign-in",
    "Admin QA Catalog Admin",
    "Admin QA",
    "Catalog Admin",
  ),
] as const;

const CONTACT_KEY_BY_ALIAS: Readonly<Record<string, keyof AdminQaActorFixtureContacts>> = {
  "admin-qa-platform-admin": "ADMIN_QA_PLATFORM_ADMIN_EMAIL",
  "admin-qa-owner": "ADMIN_QA_OWNER_EMAIL",
  "admin-qa-manager": "ADMIN_QA_MANAGER_EMAIL",
  "admin-qa-fulfillment": "ADMIN_QA_FULFILLMENT_EMAIL",
  "admin-qa-viewer": "ADMIN_QA_VIEWER_EMAIL",
  "admin-qa-catalog-admin": "ADMIN_QA_CATALOG_ADMIN_EMAIL",
};

/** Reconciles stream state, appending only the missing canonical suffix. */
export async function provisionAdminQaActorFixtures(
  services: IdentityServices,
  contacts?: AdminQaActorFixtureContacts,
): Promise<readonly AdminQaActorFixtureResult[]> {
  const resolved = resolveContacts(services, contacts);
  const context = createIdentityBootstrapContext();
  const results: AdminQaActorFixtureResult[] = [];
  for (const actor of ADMIN_QA_ACTOR_FIXTURES) {
    results.push(await reconcileFixture(services, context, actor, resolved[CONTACT_KEY_BY_ALIAS[actor.actorAlias]]));
  }
  return results;
}

function resolveContacts(
  services: IdentityServices,
  contacts?: AdminQaActorFixtureContacts,
): AdminQaActorFixtureContacts {
  if (contacts) return validateContacts(contacts);
  // In-memory unit harnesses have no event store. Production composition must supply all six values.
  if (services.eventStore) throw new Error("Admin QA fixture provisioning requires all six ADMIN_QA_*_EMAIL inputs.");
  return {
    ADMIN_QA_PLATFORM_ADMIN_EMAIL: "admin-qa-platform-admin@invalid.test",
    ADMIN_QA_OWNER_EMAIL: "admin-qa-owner@invalid.test",
    ADMIN_QA_MANAGER_EMAIL: "admin-qa-manager@invalid.test",
    ADMIN_QA_FULFILLMENT_EMAIL: "admin-qa-fulfillment@invalid.test",
    ADMIN_QA_VIEWER_EMAIL: "admin-qa-viewer@invalid.test",
    ADMIN_QA_CATALOG_ADMIN_EMAIL: "admin-qa-catalog-admin@invalid.test",
  };
}
function validateContacts(contacts: AdminQaActorFixtureContacts): AdminQaActorFixtureContacts {
  for (const key of Object.values(CONTACT_KEY_BY_ALIAS)) {
    if (typeof contacts[key] !== "string" || contacts[key].trim() === "") throw new Error(`Missing ${key}.`);
  }
  return contacts;
}

type StateRead = { kind: "missing" | "present" | "invalid" | "error"; value?: unknown };
async function readState(reader: ((id: string) => Promise<unknown>) | undefined, id: string): Promise<StateRead> {
  if (!reader) return { kind: "missing" };
  try {
    const value = await reader(id);
    return value ? { kind: "present", value } : { kind: "missing" };
  } catch {
    return { kind: "error" };
  }
}
async function readFixtureState(
  services: IdentityServices,
  reader: ((id: string) => Promise<unknown>) | undefined,
  table: string,
  column: string,
  id: string,
): Promise<StateRead> {
  if (reader) return readState(reader, id);
  if (!services.db?.query) return { kind: "missing" };
  try {
    const result = await services.db.query(`SELECT 1 FROM ${table} WHERE ${column} = $1 LIMIT 1`, [id]);
    return result.rows.length > 0 ? { kind: "present" } : { kind: "missing" };
  } catch {
    return { kind: "error" };
  }
}
const isLegacy = (services: IdentityServices) => !services.eventStore;

async function reconcileFixture(
  services: IdentityServices,
  context: ReturnType<typeof createIdentityBootstrapContext>,
  actor: AdminQaActorFixtureDefinition,
  email: string,
  attempt = 0,
): Promise<AdminQaActorFixtureResult> {
  const base = {
    actorAlias: actor.actorAlias,
    roleKey: actor.roleKey,
    signInHost: actor.signInHost,
    capabilities: actor.capabilities,
  };
  try {
    if (services.eventStore) {
      const history = await Promise.all([
        inspectHistory(services.eventStore, `identity.account-${actor.accountId}`, ["identity.account.created"]),
        inspectHistory(services.eventStore, `identity.user-${actor.userId}`, [
          "identity.user.created",
          "identity.user.auth-method-enabled",
        ]),
        inspectHistory(services.eventStore, `identity.membership-${actor.membershipId}`, [
          "identity.membership.granted",
        ]),
        inspectHistory(services.eventStore, `identity.consent-${actor.consentId}`, ["identity.consent.recorded"]),
      ]);
      if (history.some((entry) => entry === "error")) return result(base, "error");
      if (history.some((entry) => entry === "conflict")) return result(base, "conflict");
    }
    const [account, user, membership, consent] = await Promise.all([
      readFixtureState(
        services,
        services.accounts?.getAccountState,
        "identity_accounts",
        "account_id",
        actor.accountId,
      ),
      readFixtureState(services, services.users?.getUserState, "identity_users", "user_id", actor.userId),
      readFixtureState(
        services,
        services.memberships?.getMembershipState,
        "identity_memberships",
        "membership_id",
        actor.membershipId,
      ),
      isLegacy(services)
        ? Promise.resolve<StateRead>({ kind: "missing" })
        : readFixtureState(
            services,
            services.consents?.getConsentState,
            "identity_consents",
            "consent_id",
            actor.consentId,
          ),
    ]);
    if ([account, user, membership, consent].some((x) => x.kind === "error"))
      return legacyAware(services, result(base, "error"));
    if (!isLegacy(services)) {
      if (account.kind === "present" && account.value && !matchesAccount(account.value, actor))
        return legacyAware(services, result(base, "conflict"));
      if (user.kind === "present" && user.value && !matchesUser(user.value, actor, email))
        return legacyAware(services, result(base, "conflict"));
      if (membership.kind === "present" && membership.value && !matchesMembership(membership.value, actor))
        return legacyAware(services, result(base, "conflict"));
      if (consent.kind === "present" && consent.value && !matchesConsent(consent.value, actor))
        return legacyAware(services, result(base, "conflict"));
    }
    let createdAccount = false,
      createdUser = false,
      createdMembership = false,
      createdConsent = false;
    const initiallyAbsent =
      account.kind === "missing" &&
      user.kind === "missing" &&
      membership.kind === "missing" &&
      consent.kind === "missing";
    if (account.kind === "missing") {
      await services.accounts.commandHandler({
        streamId: `identity.account-${actor.accountId}`,
        command: {
          type: "CreateAccount",
          accountId: actor.accountId,
          name: actor.accountName,
          accountType: "business",
          displayName: actor.accountName,
        },
        context,
      });
      createdAccount = true;
    }
    if (user.kind === "missing") {
      await services.users.commandHandler({
        streamId: `identity.user-${actor.userId}`,
        command: {
          type: "CreateUser",
          userId: actor.userId,
          displayName: actor.displayName,
          primaryEmail: email,
          givenName: actor.givenName,
          familyName: actor.familyName,
          primaryContactMethod: {
            contactMethodId: `ctm_${actor.userId.slice(4)}_email`,
            type: "email",
            value: email,
            verifiedAt: ADMIN_QA_ACTOR_FIXTURES_SEEDED_AT,
          },
        },
        context,
      });
      await services.users.commandHandler({
        streamId: `identity.user-${actor.userId}`,
        command: { type: "EnableAuthMethod", authMethod: "magic-link" },
        context,
      });
      createdUser = true;
    } else if (user.kind === "present" && user.value && userNeedsAuthMethod(user.value)) {
      await services.users.commandHandler({
        streamId: `identity.user-${actor.userId}`,
        command: { type: "EnableAuthMethod", authMethod: "magic-link" },
        context,
      });
      createdUser = true;
    }
    if (membership.kind === "missing") {
      await services.memberships.commandHandler({
        streamId: `identity.membership-${actor.membershipId}`,
        command: {
          type: "GrantMembership",
          membershipId: actor.membershipId,
          userId: actor.userId,
          accountId: actor.accountId,
          roleKey: actor.roleKey,
          assignmentAuthority: actor.roleKey === "platform-admin" ? { type: "platform-bootstrap" } : { type: "system" },
        },
        context,
      });
      createdMembership = true;
    }
    if (consent.kind === "missing" && services.consents?.recordTermsConsent) {
      await services.consents.recordTermsConsent({
        streamId: `identity.consent-${actor.consentId}`,
        consentId: actor.consentId,
        subjectType: "user",
        userId: actor.userId,
        accountId: actor.accountId,
        recordedAt: ADMIN_QA_ACTOR_FIXTURES_SEEDED_AT,
        context,
        authorization: authorizeConsentForProvisioning(actor.userId, actor.accountId),
        activationAuthority: services.policies.consentActivation,
      });
      createdConsent = true;
    }
    if (actor.actorAlias === "admin-qa-viewer") {
      await reconcileViewerSecondary(services, context, actor);
    }
    const steady =
      account.kind === "present" &&
      user.kind === "present" &&
      membership.kind === "present" &&
      consent.kind === "present";
    return legacyAware(services, {
      ...base,
      outcome: steady ? "steady" : initiallyAbsent ? "created" : "reconciled",
      createdAccount,
      createdUser,
      createdMembership,
      createdConsent,
    });
  } catch (error) {
    if (
      services.eventStore &&
      attempt < 2 &&
      typeof error === "object" &&
      error &&
      "code" in error &&
      error.code === "concurrency_conflict"
    ) {
      return reconcileFixture(services, context, actor, email, attempt + 1);
    }
    return legacyAware(services, result(base, "error"));
  }
}

async function reconcileViewerSecondary(
  services: IdentityServices,
  context: ReturnType<typeof createIdentityBootstrapContext>,
  actor: AdminQaActorFixtureDefinition,
): Promise<void> {
  if (!services.eventStore) return;
  const secondaryAccountId = "acc_admin_qa_viewer_secondary" as AccountId;
  const secondaryMembershipId = "mbr_admin_qa_viewer_secondary" as MembershipId;
  const secondaryConsentId = "cns_admin_qa_viewer_secondary" as ConsentId;
  if (services.eventStore) {
    const history = await Promise.all([
      inspectHistory(services.eventStore, `identity.account-${secondaryAccountId}`, ["identity.account.created"]),
      inspectHistory(services.eventStore, `identity.membership-${secondaryMembershipId}`, [
        "identity.membership.granted",
      ]),
      inspectHistory(services.eventStore, `identity.consent-${secondaryConsentId}`, ["identity.consent.recorded"]),
    ]);
    if (history.some((entry) => entry === "error" || entry === "conflict"))
      throw new Error("Viewer secondary history conflict.");
  }
  const account = await readFixtureState(
    services,
    services.accounts?.getAccountState,
    "identity_accounts",
    "account_id",
    secondaryAccountId,
  );
  const membership = await readFixtureState(
    services,
    services.memberships?.getMembershipState,
    "identity_memberships",
    "membership_id",
    secondaryMembershipId,
  );
  const consent = await readFixtureState(
    services,
    services.consents?.getConsentState,
    "identity_consents",
    "consent_id",
    secondaryConsentId,
  );
  if ([account, membership, consent].some((x) => x.kind === "error"))
    throw new Error("Viewer secondary state could not be read.");
  if (account.kind === "present" && !matchesSecondaryAccount(account.value, secondaryAccountId))
    throw new Error("Viewer secondary account conflict.");
  if (
    membership.kind === "present" &&
    !matchesSecondaryMembership(membership.value, actor, secondaryAccountId, secondaryMembershipId)
  )
    throw new Error("Viewer secondary membership conflict.");
  if (
    consent.kind === "present" &&
    !matchesSecondaryConsent(consent.value, actor, secondaryAccountId, secondaryConsentId)
  )
    throw new Error("Viewer secondary consent conflict.");
  if (account.kind === "missing")
    await services.accounts.commandHandler({
      streamId: `identity.account-${secondaryAccountId}`,
      command: {
        type: "CreateAccount",
        accountId: secondaryAccountId,
        name: "Admin QA Viewer Secondary",
        accountType: "business",
        displayName: "Admin QA Viewer Secondary",
      },
      context,
    });
  if (membership.kind === "missing")
    await services.memberships.commandHandler({
      streamId: `identity.membership-${secondaryMembershipId}`,
      command: {
        type: "GrantMembership",
        membershipId: secondaryMembershipId,
        userId: actor.userId,
        accountId: secondaryAccountId,
        roleKey: "viewer",
        assignmentAuthority: { type: "system" },
      },
      context,
    });
  if (consent.kind === "missing" && services.consents?.recordTermsConsent)
    await services.consents.recordTermsConsent({
      streamId: `identity.consent-${secondaryConsentId}`,
      consentId: secondaryConsentId,
      subjectType: "user",
      userId: actor.userId,
      accountId: secondaryAccountId,
      recordedAt: ADMIN_QA_ACTOR_FIXTURES_SEEDED_AT,
      context,
      authorization: authorizeConsentForProvisioning(actor.userId, secondaryAccountId),
      activationAuthority: services.policies.consentActivation,
    });
}
function result(
  base: Omit<
    AdminQaActorFixtureResult,
    "outcome" | "createdAccount" | "createdUser" | "createdMembership" | "createdConsent"
  >,
  outcome: AdminQaActorFixtureOutcome,
): AdminQaActorFixtureResult {
  return {
    ...base,
    outcome,
    createdAccount: false,
    createdUser: false,
    createdMembership: false,
    createdConsent: false,
  };
}
function legacyAware(services: IdentityServices, value: AdminQaActorFixtureResult): AdminQaActorFixtureResult {
  if (services.eventStore) return value;
  const { outcome: _outcome, createdConsent: _createdConsent, ...legacy } = value;
  return legacy as AdminQaActorFixtureResult;
}
async function inspectHistory(
  eventStore: NonNullable<IdentityServices["eventStore"]>,
  streamId: string,
  allowed: readonly string[],
): Promise<"missing" | "present" | "conflict" | "error"> {
  try {
    const events = await readCompleteStream(eventStore, { streamId, maxEvents: 10_000 });
    if (events.length === 0) return "missing";
    if (events.length > allowed.length || events.some((event) => !allowed.includes(event.eventType))) return "conflict";
    for (let index = 0; index < events.length; index += 1) {
      if (events[index].eventType !== allowed[index]) return "conflict";
    }
    return "present";
  } catch {
    return "error";
  }
}

function matchesAccount(value: unknown, actor: AdminQaActorFixtureDefinition): boolean {
  const state = value as Record<string, unknown>;
  return (
    state.id === actor.accountId &&
    state.name === actor.accountName &&
    state.displayName === actor.accountName &&
    state.accountType === "business" &&
    state.status === "active"
  );
}
function matchesUser(value: unknown, actor: AdminQaActorFixtureDefinition, email: string): boolean {
  const state = value as Record<string, unknown>;
  const contacts = Array.isArray(state.contactMethods) ? (state.contactMethods as Array<Record<string, unknown>>) : [];
  return (
    state.id === actor.userId &&
    state.displayName === actor.displayName &&
    state.givenName === actor.givenName &&
    state.familyName === actor.familyName &&
    state.status === "active" &&
    state.primaryEmail === email &&
    Array.isArray(state.authMethods) &&
    (state.authMethods.length === 0 || (state.authMethods.length === 1 && state.authMethods[0] === "magic-link")) &&
    contacts.length === 1 &&
    contacts[0].type === "email" &&
    contacts[0].value === email
  );
}
function userNeedsAuthMethod(value: unknown): boolean {
  const methods = (value as Record<string, unknown>).authMethods;
  return Array.isArray(methods) && methods.length === 0;
}
function matchesMembership(value: unknown, actor: AdminQaActorFixtureDefinition): boolean {
  const state = value as Record<string, unknown>;
  return (
    state.id === actor.membershipId &&
    state.userId === actor.userId &&
    state.accountId === actor.accountId &&
    state.roleKey === actor.roleKey &&
    state.status === "active"
  );
}
function matchesConsent(value: unknown, actor: AdminQaActorFixtureDefinition): boolean {
  const state = value as Record<string, unknown>;
  return (
    state.id === actor.consentId &&
    state.userId === actor.userId &&
    state.accountId === actor.accountId &&
    state.subjectType === "user" &&
    state.status === "recorded" &&
    state.policyKey === "terms-of-service"
  );
}
function matchesSecondaryAccount(value: unknown, id: string): boolean {
  const state = value as Record<string, unknown>;
  return (
    state.id === id &&
    state.name === "Admin QA Viewer Secondary" &&
    state.displayName === "Admin QA Viewer Secondary" &&
    state.accountType === "business" &&
    state.status === "active"
  );
}
function matchesSecondaryMembership(
  value: unknown,
  actor: AdminQaActorFixtureDefinition,
  accountId: string,
  membershipId: string,
): boolean {
  const state = value as Record<string, unknown>;
  return (
    state.id === membershipId &&
    state.userId === actor.userId &&
    state.accountId === accountId &&
    state.roleKey === "viewer" &&
    state.status === "active"
  );
}
function matchesSecondaryConsent(
  value: unknown,
  actor: AdminQaActorFixtureDefinition,
  accountId: string,
  consentId: string,
): boolean {
  const state = value as Record<string, unknown>;
  return (
    state.id === consentId &&
    state.userId === actor.userId &&
    state.accountId === accountId &&
    state.subjectType === "user" &&
    state.status === "recorded" &&
    state.policyKey === "terms-of-service"
  );
}
