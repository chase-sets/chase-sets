import type { AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { AccountId, MembershipId, UserId } from "@chase-sets/primitives/typed-ids";
import { evolveAccount, initialAccountState } from "../../features/accounts/domain/domain";
import { evolveMembership, initialMembershipState } from "../../features/memberships/domain/domain";
import { evolveUser, initialUserState } from "../../features/users/domain/domain";
import type { RoleKey } from "./common";
import { createIdentityBootstrapContext } from "./bootstrap-context";
import type { IdentityServices } from "./services";
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

/** The viewer's second Account and Membership, bound to the same User. */
const ADMIN_QA_VIEWER_SECONDARY_FIXTURE: AdminQaActorFixtureDefinition = {
  ...ADMIN_QA_ACTOR_FIXTURES[4],
  accountId: "acc_admin_qa_viewer_secondary" as AccountId,
  membershipId: "mbr_admin_qa_viewer_secondary" as MembershipId,
  accountName: "Admin QA Viewer Secondary",
};

const CONTACT_KEY_BY_ALIAS: Readonly<Record<string, keyof AdminQaActorFixtureContacts>> = {
  "admin-qa-platform-admin": "ADMIN_QA_PLATFORM_ADMIN_EMAIL",
  "admin-qa-owner": "ADMIN_QA_OWNER_EMAIL",
  "admin-qa-manager": "ADMIN_QA_MANAGER_EMAIL",
  "admin-qa-fulfillment": "ADMIN_QA_FULFILLMENT_EMAIL",
  "admin-qa-viewer": "ADMIN_QA_VIEWER_EMAIL",
  "admin-qa-catalog-admin": "ADMIN_QA_CATALOG_ADMIN_EMAIL",
};

/**
 * Reconciles stream state, appending only the missing canonical suffix. No
 * Consent is recorded or read: no human affirms anything here, so provisioning
 * authors no synthetic Consent fact.
 */
export async function provisionAdminQaActorFixtures(
  services: IdentityServices,
  contacts: AdminQaActorFixtureContacts,
): Promise<readonly AdminQaActorFixtureResult[]> {
  const resolved = validateContacts(contacts);
  const context = createIdentityBootstrapContext();
  const results: AdminQaActorFixtureResult[] = [];
  for (const fixture of ADMIN_QA_ACTOR_FIXTURES) {
    const email = resolved[CONTACT_KEY_BY_ALIAS[fixture.actorAlias]];
    if (!services.eventStore) {
      // In-memory harnesses have no streams to classify, so they report creation flags only.
      const { outcome: _outcome, ...flags } = await provisionAdminQaActorFixture(services, context, fixture, email);
      results.push(flags);
    } else if (fixture.actorAlias === ADMIN_QA_VIEWER_SECONDARY_FIXTURE.actorAlias) {
      results.push(await provisionAdminQaViewerFixture(services, context, fixture, email));
    } else {
      results.push(await provisionAdminQaActorFixture(services, context, fixture, email));
    }
  }
  return results;
}

function validateContacts(contacts: AdminQaActorFixtureContacts): AdminQaActorFixtureContacts {
  for (const key of Object.values(CONTACT_KEY_BY_ALIAS)) {
    if (typeof contacts[key] !== "string" || contacts[key].trim() === "") throw new Error(`Missing ${key}.`);
  }
  return contacts;
}

/** Reads the secondary binding before the viewer appends; one outcome covers both. */
async function provisionAdminQaViewerFixture(
  services: IdentityServices,
  context: ReturnType<typeof createIdentityBootstrapContext>,
  fixture: AdminQaActorFixtureDefinition,
  email: string,
): Promise<AdminQaActorFixtureResult> {
  const secondary = await inspectAdminQaActorFixture(services, ADMIN_QA_VIEWER_SECONDARY_FIXTURE, email);
  if (secondary.kind !== "readable") return outcomeOnly(fixture, secondary.kind);
  const primary = await provisionAdminQaActorFixture(services, context, fixture, email);
  if (primary.outcome === "conflict" || primary.outcome === "error") return primary;
  const second = await provisionAdminQaActorFixture(services, context, ADMIN_QA_VIEWER_SECONDARY_FIXTURE, email);
  if (second.outcome === "conflict" || second.outcome === "error") return outcomeOnly(fixture, second.outcome);
  // The User is shared, so the secondary binding is judged by its own Account and Membership.
  const secondaryReads = [secondary.account.kind, secondary.membership.kind];
  const outcome =
    primary.outcome === "created" && secondaryReads.every((kind) => kind === "missing")
      ? "created"
      : primary.outcome === "steady" && secondaryReads.every((kind) => kind === "present")
        ? "steady"
        : "reconciled";
  return {
    ...primary,
    outcome,
    createdAccount: primary.createdAccount || second.createdAccount,
    createdUser: primary.createdUser || second.createdUser,
    createdMembership: primary.createdMembership || second.createdMembership,
  };
}

async function provisionAdminQaActorFixture(
  services: IdentityServices,
  context: ReturnType<typeof createIdentityBootstrapContext>,
  fixture: AdminQaActorFixtureDefinition,
  email: string,
  attempt = 0,
): Promise<AdminQaActorFixtureResult> {
  let createdAccount = false;
  let createdUser = false;
  let createdMembership = false;
  let outcome: AdminQaActorFixtureOutcome;
  try {
    const state = await inspectAdminQaActorFixture(services, fixture, email);
    if (state.kind !== "readable") return outcomeOnly(fixture, state.kind);
    const { account, user, membership } = state;

    if (account.kind === "missing") {
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
    if (user.kind === "missing") {
      await services.users.commandHandler({
        streamId: `identity.user-${fixture.userId}`,
        command: {
          type: "CreateUser",
          userId: fixture.userId,
          displayName: fixture.displayName,
          primaryEmail: email,
          givenName: fixture.givenName,
          familyName: fixture.familyName,
          primaryContactMethod: {
            contactMethodId: `ctm_${fixture.userId.slice(4)}_email`,
            type: "email",
            value: email,
            verifiedAt: ADMIN_QA_ACTOR_FIXTURES_SEEDED_AT,
          },
        },
        context,
      });
    }
    if (user.kind === "missing" || userNeedsAuthMethod(user.value)) {
      // Also resumes a User created before its magic-link method was enabled.
      await services.users.commandHandler({
        streamId: `identity.user-${fixture.userId}`,
        command: { type: "EnableAuthMethod", authMethod: "magic-link" },
        context,
      });
      createdUser = true;
    }
    if (membership.kind === "missing") {
      await services.memberships.commandHandler({
        streamId: `identity.membership-${fixture.membershipId}`,
        command: {
          type: "GrantMembership",
          membershipId: fixture.membershipId,
          userId: fixture.userId,
          accountId: fixture.accountId,
          roleKey: fixture.roleKey,
          assignmentAuthority:
            fixture.roleKey === "platform-admin" ? { type: "platform-bootstrap" } : { type: "system" },
        },
        context,
      });
      createdMembership = true;
    }
    const absent = [account, user, membership].filter((read) => read.kind === "missing").length;
    outcome = absent === 0 && !createdUser ? "steady" : absent === 3 ? "created" : "reconciled";
  } catch {
    // A concurrent boot can win each of the four appends once; every retry re-reads all histories first.
    if (services.eventStore && attempt < 4) {
      return provisionAdminQaActorFixture(services, context, fixture, email, attempt + 1);
    }
    return outcomeOnly(fixture, "error");
  }

  return {
    actorAlias: fixture.actorAlias,
    roleKey: fixture.roleKey,
    signInHost: fixture.signInHost,
    capabilities: fixture.capabilities,
    outcome,
    createdAccount,
    createdUser,
    createdMembership,
  };
}

type StateRead = { kind: "missing" | "present" | "conflict" | "error"; value?: unknown };
type FixtureInspection =
  | { kind: "readable"; account: StateRead; user: StateRead; membership: StateRead }
  | { kind: "conflict" | "error" };

/** Inspects complete stream histories and the state they rehydrate to before any append. */
async function inspectAdminQaActorFixture(
  services: IdentityServices,
  fixture: AdminQaActorFixtureDefinition,
  email: string,
): Promise<FixtureInspection> {
  const store = services.eventStore;
  const [account, user, membership] = await Promise.all(
    store
      ? [
          readCanonicalStream(
            store,
            `identity.account-${fixture.accountId}`,
            ["identity.account.created"],
            initialAccountState,
            evolveAccount,
          ),
          readCanonicalStream(
            store,
            `identity.user-${fixture.userId}`,
            ["identity.user.created", "identity.user.auth-method-enabled"],
            initialUserState,
            evolveUser,
          ),
          readCanonicalStream(
            store,
            `identity.membership-${fixture.membershipId}`,
            ["identity.membership.granted"],
            initialMembershipState,
            evolveMembership,
          ),
        ]
      : [
          readFixtureState(
            services.db,
            services.accounts?.getAccountState,
            "identity_accounts",
            "account_id",
            fixture.accountId,
          ),
          readFixtureState(services.db, services.users?.getUserState, "identity_users", "user_id", fixture.userId),
          readFixtureState(
            services.db,
            services.memberships?.getMembershipState,
            "identity_memberships",
            "membership_id",
            fixture.membershipId,
          ),
        ],
  );
  const reads = [account, user, membership];
  if (reads.some((read) => read.kind === "error")) return { kind: "error" };
  if (reads.some((read) => read.kind === "conflict")) return { kind: "conflict" };
  if (store) {
    if (account.kind === "present" && !matchesAccount(account.value, fixture)) return { kind: "conflict" };
    if (user.kind === "present" && !matchesUser(user.value, fixture, email)) return { kind: "conflict" };
    if (membership.kind === "present" && !matchesMembership(membership.value, fixture)) return { kind: "conflict" };
  }
  return { kind: "readable", account, user, membership };
}

async function readFixtureState(
  db: IdentityServices["db"],
  reader: ((id: string) => Promise<unknown>) | undefined,
  table: string,
  column: string,
  id: string,
): Promise<StateRead> {
  try {
    if (reader) {
      const value = await reader(id);
      return value ? { kind: "present", value } : { kind: "missing" };
    }
    // In-memory harnesses without stream readers fall back to the projection row.
    const result = await db.query(`SELECT 1 FROM ${table} WHERE ${column} = $1 LIMIT 1`, [id]);
    return result.rows.length > 0 ? { kind: "present" } : { kind: "missing" };
  } catch {
    return { kind: "error" };
  }
}

function outcomeOnly(
  fixture: AdminQaActorFixtureDefinition,
  outcome: AdminQaActorFixtureOutcome,
): AdminQaActorFixtureResult {
  const { actorAlias, roleKey, signInHost, capabilities } = fixture;
  return {
    actorAlias,
    roleKey,
    signInHost,
    capabilities,
    outcome,
    createdAccount: false,
    createdUser: false,
    createdMembership: false,
  };
}

/**
 * One complete read decides both the history's shape and its state, so a
 * concurrent append cannot split them. Canonical-looking history that does
 * not rehydrate to an identified aggregate is malformed, not absent.
 */
async function readCanonicalStream<State extends Readonly<{ id: unknown }>, Event extends DomainEvent>(
  eventStore: NonNullable<IdentityServices["eventStore"]>,
  streamId: string,
  allowed: readonly string[],
  initialState: State,
  evolve: AggregateEvolver<State, Event>,
): Promise<StateRead> {
  let events: Awaited<ReturnType<typeof readCompleteStream>>;
  try {
    events = await readCompleteStream(eventStore, { streamId, maxEvents: 10_000 });
  } catch {
    return { kind: "error" };
  }
  if (events.length === 0) return { kind: "missing" };
  if (events.length > allowed.length || events.some((event, index) => event.eventType !== allowed[index])) {
    return { kind: "conflict" };
  }
  try {
    const codec = createPassthroughDomainEventCodec<Event>();
    const value = events.reduce((state, event) => evolve(state, codec.decode(event)), initialState);
    return value.id ? { kind: "present", value } : { kind: "conflict" };
  } catch {
    return { kind: "conflict" };
  }
}

function matchesAccount(value: unknown, fixture: AdminQaActorFixtureDefinition): boolean {
  const state = value as Record<string, unknown>;
  return (
    state.id === fixture.accountId &&
    state.name === fixture.accountName &&
    state.displayName === fixture.accountName &&
    state.accountType === "business" &&
    state.status === "active"
  );
}
function matchesUser(value: unknown, fixture: AdminQaActorFixtureDefinition, email: string): boolean {
  const state = value as Record<string, unknown>;
  const contacts = Array.isArray(state.contactMethods) ? (state.contactMethods as Array<Record<string, unknown>>) : [];
  return (
    state.id === fixture.userId &&
    state.displayName === fixture.displayName &&
    state.givenName === fixture.givenName &&
    state.familyName === fixture.familyName &&
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
  const methods = (value as Record<string, unknown> | undefined)?.authMethods;
  return Array.isArray(methods) && methods.length === 0;
}
function matchesMembership(value: unknown, fixture: AdminQaActorFixtureDefinition): boolean {
  const state = value as Record<string, unknown>;
  return (
    state.id === fixture.membershipId &&
    state.userId === fixture.userId &&
    state.accountId === fixture.accountId &&
    state.roleKey === fixture.roleKey &&
    state.status === "active"
  );
}
