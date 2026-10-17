import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { composeModuleSchemaSql } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { AccountId, MembershipId, UserId } from "@chase-sets/primitives/typed-ids";
import { module as identityModule } from "../index";
import { DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY } from "../features/account-capabilities/api/authority";
import {
  ADMIN_QA_ACTOR_FIXTURES,
  provisionAdminQaActorFixtures,
  type AdminQaActorFixtureContacts,
  type AdminQaActorFixtureOutcome,
  type AdminQaActorFixtureResult,
} from "../support/runtime-support/admin-qa-actor-fixtures";
import { createIdentityBootstrapContext } from "../support/runtime-support/bootstrap-context";
import { createIdentityServices, type IdentityServices } from "../support/runtime-support/services";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for Identity Admin QA fixture database tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;

// Synthetic reserved-domain contacts; the fixture definitions hold none.
const CONTACTS: AdminQaActorFixtureContacts = {
  ADMIN_QA_PLATFORM_ADMIN_EMAIL: "platform-admin@admin-qa.test",
  ADMIN_QA_OWNER_EMAIL: "owner@admin-qa.test",
  ADMIN_QA_MANAGER_EMAIL: "manager@admin-qa.test",
  ADMIN_QA_FULFILLMENT_EMAIL: "fulfillment@admin-qa.test",
  ADMIN_QA_VIEWER_EMAIL: "viewer@admin-qa.test",
  ADMIN_QA_CATALOG_ADMIN_EMAIL: "catalog-admin@admin-qa.test",
};
const ALIASES = ADMIN_QA_ACTOR_FIXTURES.map((fixture) => fixture.actorAlias);
const VIEWER = "admin-qa-viewer";
const SECONDARY_ACCOUNT = "identity.account-acc_admin_qa_viewer_secondary";
const SECONDARY_MEMBERSHIP = "identity.membership-mbr_admin_qa_viewer_secondary";
const ENFORCEMENT = {
  version: 1,
  enforcementActionId: "enf_01ARYZ6S41TSV4RRFFQ69G5FAV",
  reason: "operator-other",
  reference: null,
} as const;

type Streams = Readonly<Record<string, number>>;
type Plant = (services: IdentityServices) => Promise<void>;

const snake = (alias: string) => alias.replaceAll("-", "_");
const fixtureOf = (alias: string) => ADMIN_QA_ACTOR_FIXTURES.find((fixture) => fixture.actorAlias === alias)!;
const emailOf = (alias: string) =>
  CONTACTS[
    `ADMIN_QA_${snake(alias).slice("admin_qa_".length).toUpperCase()}_EMAIL` as keyof AdminQaActorFixtureContacts
  ];

/** Every stream one alias owns, with the events a clean run appends to each. */
function cleanRun(alias: string): Streams {
  const id = snake(alias);
  return {
    [`identity.account-acc_${id}`]: 1,
    [`identity.user-usr_${id}`]: 2,
    [`identity.membership-mbr_${id}`]: 1,
    ...(alias === VIEWER ? { [SECONDARY_ACCOUNT]: 1, [SECONDARY_MEMBERSHIP]: 1 } : {}),
  };
}
const zero = (streams: Streams): Streams => Object.fromEntries(Object.keys(streams).map((stream) => [stream, 0]));
const cleanRunAll = (): Streams => Object.assign({}, ...ALIASES.map(cleanRun));
const outcomes = (results: readonly AdminQaActorFixtureResult[]) =>
  Object.fromEntries(results.map((result) => [result.actorAlias, result.outcome]));
const allOutcomes = (outcome: AdminQaActorFixtureOutcome, overrides: Record<string, AdminQaActorFixtureOutcome> = {}) =>
  Object.fromEntries(ALIASES.map((alias) => [alias, overrides[alias] ?? outcome]));

describeDb("Admin QA actor fixtures against real PostgreSQL", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>>;
  let services: IdentityServices;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["identity"], "identity_admin_qa_fixtures");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.identity.query(composeModuleSchemaSql(identityModule));
    services = boot();
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function boot(): IdentityServices {
    return createIdentityServices(pools.identity, {
      capabilityAdministrationAuthority: DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY,
    });
  }

  /** Event counts for every Admin QA stream, read from the event store itself. */
  async function streamCounts(): Promise<Streams> {
    const result = await pools.identity.query<{ stream_id: string; events: number }>(
      `SELECT stream_id, count(*)::int AS events FROM event_store_events
        WHERE position('admin_qa' in stream_id) > 0 GROUP BY stream_id`,
    );
    return Object.fromEntries(result.rows.map((row) => [row.stream_id, row.events]));
  }
  function deltas(before: Streams, after: Streams, streams: Streams): Streams {
    return Object.fromEntries(Object.keys(streams).map((id) => [id, (after[id] ?? 0) - (before[id] ?? 0)]));
  }
  async function provision(current: IdentityServices = services) {
    const before = await streamCounts();
    const results = await provisionAdminQaActorFixtures(current, CONTACTS);
    const after = await streamCounts();
    return { outcomes: outcomes(results), delta: (streams: Streams) => deltas(before, after, streams) };
  }

  it("creates every actor from nothing beside unrelated rows, then same-boot and boot-two runs are steady", async () => {
    // Unrelated Identity state and a stray projection row for a target are not completeness.
    await createAccount("acc_unrelated_control", { name: "Unrelated Control" });
    await pools.identity.query(
      `INSERT INTO identity_accounts (account_id, name, display_name, account_type, status)
       VALUES ('acc_admin_qa_owner', 'Admin QA Owner', 'Admin QA Owner', 'business', 'active')`,
    );

    const clean = await provision();
    expect(clean.outcomes).toEqual(allOutcomes("created"));
    expect(clean.delta(cleanRunAll())).toEqual(cleanRunAll());

    const repeat = await provision();
    expect(repeat.outcomes).toEqual(allOutcomes("steady"));
    expect(repeat.delta(cleanRunAll())).toEqual(zero(cleanRunAll()));

    const bootTwo = await provision(boot());
    expect(bootTwo.outcomes).toEqual(allOutcomes("steady"));
    expect(bootTwo.delta(cleanRunAll())).toEqual(zero(cleanRunAll()));

    await expect(eventTypes(`identity.user-usr_admin_qa_owner`)).resolves.toEqual([
      "identity.user.created",
      "identity.user.auth-method-enabled",
    ]);
  });

  // Commands per alias in the provisioner's order: Account, User, magic-link,
  // Membership; the viewer then adds its secondary Account and Membership.
  const boundaries = ALIASES.flatMap((alias) =>
    Array.from({ length: alias === VIEWER ? 5 : 3 }, (_, index) => ({ alias, appended: index + 1 })),
  );

  it.each(boundaries)(
    "resumes $alias interrupted after $appended canonical commands as reconciled with only the missing suffix",
    async ({ alias, appended }) => {
      const interrupted = await provision(interruptAfter(services, alias, appended));
      expect(interrupted.outcomes).toEqual(allOutcomes("created", { [alias]: "error" }));
      const prefix = interrupted.delta(cleanRun(alias));
      expect(Object.values(prefix).reduce((sum, count) => sum + count, 0)).toBe(appended);
      if (appended === 2) {
        // The boundary after identity.user.created and before identity.user.auth-method-enabled.
        await expect(eventTypes(`identity.user-usr_${snake(alias)}`)).resolves.toEqual(["identity.user.created"]);
      }

      const resumed = await provision(boot());
      expect(resumed.outcomes).toEqual(allOutcomes("steady", { [alias]: "reconciled" }));
      const expected = Object.fromEntries(
        Object.entries(cleanRun(alias)).map(([stream, count]) => [stream, count - (prefix[stream] ?? 0)]),
      );
      expect(resumed.delta(cleanRun(alias))).toEqual(expected);
      expect(await streamCounts()).toEqual(cleanRunAll());

      const again = await provision(boot());
      expect(again.outcomes).toEqual(allOutcomes("steady"));
    },
  );

  const conflicts: ReadonlyArray<readonly [string, string, Plant]> = [
    [
      "Account identity",
      "admin-qa-owner",
      () => createAccount("acc_admin_qa_owner", { accountId: "acc_admin_qa_impostor" }),
    ],
    [
      "Account display",
      "admin-qa-owner",
      () => createAccount("acc_admin_qa_owner", { name: "Admin QA Owner Renamed" }),
    ],
    ["Account type", "admin-qa-owner", () => createAccount("acc_admin_qa_owner", { accountType: "personal" })],
    [
      "Account status (terminal suspension)",
      "admin-qa-owner",
      async () => {
        await createAccount("acc_admin_qa_owner");
        await accountCommand("acc_admin_qa_owner", { type: "SuspendAccount", enforcement: ENFORCEMENT });
      },
    ],
    [
      "unexpected Account event",
      "admin-qa-owner",
      async () => {
        await createAccount("acc_admin_qa_owner");
        await accountCommand("acc_admin_qa_owner", { type: "UpdateAccountProfile", name: "Admin QA Owner" });
      },
    ],
    ["User identity", "admin-qa-owner", () => createUser("admin-qa-owner", { userId: "usr_admin_qa_impostor" })],
    ["User contact", "admin-qa-owner", () => createUser("admin-qa-owner", { email: "someone-else@admin-qa.test" })],
    [
      "User auth (poisoned canonical event types)",
      "admin-qa-owner",
      async () => {
        await createUser("admin-qa-owner");
        await userCommand("admin-qa-owner", { type: "EnableAuthMethod", authMethod: "password" });
      },
    ],
    [
      "User extra auth method",
      "admin-qa-owner",
      async () => {
        await createUser("admin-qa-owner");
        await userCommand("admin-qa-owner", { type: "EnableAuthMethod", authMethod: "magic-link" });
        await userCommand("admin-qa-owner", { type: "EnableAuthMethod", authMethod: "passkey" });
      },
    ],
    [
      "User status (terminal suspension)",
      "admin-qa-owner",
      async () => {
        await createUser("admin-qa-owner");
        await userCommand("admin-qa-owner", { type: "SuspendUser" });
      },
    ],
    ["Membership role", "admin-qa-manager", () => grant("admin-qa-manager", { roleKey: "owner" })],
    [
      "Membership assignment (Account binding)",
      "admin-qa-manager",
      () => grant("admin-qa-manager", { accountId: "acc_admin_qa_owner" }),
    ],
    [
      "Membership assignment (User binding)",
      "admin-qa-manager",
      () => grant("admin-qa-manager", { userId: "usr_admin_qa_owner" }),
    ],
    [
      "Membership status (terminal revocation)",
      "admin-qa-manager",
      async () => {
        await grant("admin-qa-manager");
        await services.memberships.commandHandler({
          streamId: "identity.membership-mbr_admin_qa_manager",
          command: { type: "RevokeMembership" },
          context: createIdentityBootstrapContext(),
        });
      },
    ],
    [
      "malformed history (canonical type, unreadable payload)",
      "admin-qa-fulfillment",
      () =>
        appendRaw("identity.account-acc_admin_qa_fulfillment", [
          { eventType: "identity.account.created", payload: {} },
        ]),
    ],
    [
      "unknown event type",
      "admin-qa-fulfillment",
      () =>
        appendRaw("identity.account-acc_admin_qa_fulfillment", [
          { eventType: "identity.account.mystery", payload: {} },
        ]),
    ],
    [
      "poisoned duplicate creation",
      "admin-qa-fulfillment",
      async () => {
        await createUser("admin-qa-fulfillment");
        const [created] = await services.eventStore!.readStream({ streamId: "identity.user-usr_admin_qa_fulfillment" });
        await appendRaw(
          "identity.user-usr_admin_qa_fulfillment",
          [{ eventType: "identity.user.created", payload: created!.payload }],
          1,
        );
      },
    ],
    [
      "decisive event 501 after 500 canonical-looking events",
      "admin-qa-catalog-admin",
      () =>
        appendRaw("identity.account-acc_admin_qa_catalog_admin", [
          ...Array.from({ length: 500 }, () => ({
            eventType: "identity.account.created",
            payload: {
              accountId: "acc_admin_qa_catalog_admin",
              name: "Admin QA Catalog Admin",
              displayName: "Admin QA Catalog Admin",
              accountType: "business",
            },
          })),
          { eventType: "identity.account.suspended", payload: { enforcement: ENFORCEMENT } },
        ]),
    ],
    ["viewer secondary role", VIEWER, () => grantSecondary({ roleKey: "owner" })],
    ["viewer secondary binding", VIEWER, () => grantSecondary({ accountId: "acc_admin_qa_viewer" })],
    [
      "viewer secondary Account display",
      VIEWER,
      () => createAccount("acc_admin_qa_viewer_secondary", { name: "Admin QA Viewer Tertiary" }),
    ],
    [
      "viewer secondary Account status (terminal closure)",
      VIEWER,
      async () => {
        await createAccount("acc_admin_qa_viewer_secondary", { name: "Admin QA Viewer Secondary" });
        await accountCommand("acc_admin_qa_viewer_secondary", { type: "CloseAccount", enforcement: ENFORCEMENT });
      },
    ],
  ];

  it.each(conflicts)("classifies %s on %s as conflict and appends nothing to it", async (_name, alias, plant) => {
    await plant(services);
    const run = await provision();
    expect(run.outcomes).toEqual(allOutcomes("created", { [alias]: "conflict" }));
    expect(run.delta(cleanRun(alias))).toEqual(zero(cleanRun(alias)));
    const others = Object.assign({}, ...ALIASES.filter((other) => other !== alias).map(cleanRun));
    expect(run.delta(others)).toEqual(others);

    const rerun = await provision(boot());
    expect(rerun.outcomes).toEqual(allOutcomes("steady", { [alias]: "conflict" }));
    expect(rerun.delta(cleanRun(alias))).toEqual(zero(cleanRun(alias)));
  });

  // The incomplete page needs a present stream, so that case first creates the owner Account.
  const failures: ReadonlyArray<readonly [string, string, (base: IdentityServices) => IdentityServices, boolean]> = [
    ["a stream read error", "admin-qa-owner", (base) => failingRead(base, "identity.user-usr_admin_qa_owner"), false],
    ["an incomplete page", "admin-qa-owner", (base) => gappedRead(base, "identity.account-acc_admin_qa_owner"), true],
    [
      "a state read error",
      "admin-qa-manager",
      (base) => ({
        ...base,
        memberships: {
          ...base.memberships,
          getMembershipState: async (membershipId: string) => {
            if (membershipId === "mbr_admin_qa_manager") throw new Error("synthetic state read failure");
            return base.memberships.getMembershipState(membershipId);
          },
        },
      }),
      false,
    ],
    ["a viewer secondary read error", VIEWER, (base) => failingRead(base, SECONDARY_MEMBERSHIP), false],
  ];

  it.each(failures)("classifies %s on %s as error without any append to it", async (_name, alias, wrap, planted) => {
    if (planted) await createAccount("acc_admin_qa_owner");
    const run = await provision(wrap(services));
    expect(run.outcomes).toEqual(allOutcomes("created", { [alias]: "error" }));
    expect(run.delta(cleanRun(alias))).toEqual(zero(cleanRun(alias)));

    const recovered = await provision(boot());
    expect(recovered.outcomes).toEqual(allOutcomes("steady", { [alias]: planted ? "reconciled" : "created" }));
    expect(await streamCounts()).toEqual(cleanRunAll());
  });

  it("nets exactly one creation when two boots provision concurrently", async () => {
    const [first, second] = await Promise.all([
      provisionAdminQaActorFixtures(boot(), CONTACTS),
      provisionAdminQaActorFixtures(boot(), CONTACTS),
    ]);
    for (const results of [first, second]) {
      for (const outcome of Object.values(outcomes(results))) {
        expect(["created", "reconciled", "steady"]).toContain(outcome);
      }
    }
    expect(await streamCounts()).toEqual(cleanRunAll());
    expect((await provision(boot())).outcomes).toEqual(allOutcomes("steady"));
  });

  it("gives only the viewer two active Memberships with the exact display values and no Consent", async () => {
    expect((await provision()).outcomes).toEqual(allOutcomes("created"));
    await expect(membershipEnumeration()).resolves.toEqual(
      [
        ...ALIASES.filter((alias) => alias !== VIEWER).map((alias) => ({
          actorAlias: alias,
          userId: `usr_${snake(alias)}`,
          membershipId: `mbr_${snake(alias)}`,
          accountId: `acc_${snake(alias)}`,
          accountName: fixtureOf(alias).accountName,
          displayName: fixtureOf(alias).accountName,
          roleKey: fixtureOf(alias).roleKey,
          membershipStatus: "active",
          accountStatus: "active",
        })),
        ...[
          ["mbr_admin_qa_viewer", "acc_admin_qa_viewer", "Admin QA Viewer Primary"],
          ["mbr_admin_qa_viewer_secondary", "acc_admin_qa_viewer_secondary", "Admin QA Viewer Secondary"],
        ].map(([membershipId, accountId, accountName]) => ({
          actorAlias: VIEWER,
          userId: "usr_admin_qa_viewer",
          membershipId,
          accountId,
          accountName,
          displayName: accountName,
          roleKey: "viewer",
          membershipStatus: "active",
          accountStatus: "active",
        })),
      ].sort(byMembership),
    );
    await expect(aliasesWithSeveralMemberships()).resolves.toEqual([VIEWER]);
    // #8945 supersedes the Consent column: provisioning records no Consent fact.
    const consents = await pools.identity.query(
      "SELECT 1 FROM event_store_events WHERE stream_id LIKE 'identity.consent-%'",
    );
    expect(consents.rows).toEqual([]);

    // A second Membership planted on any other actor is visible to the same enumeration.
    await createAccount("acc_admin_qa_planted", { name: "Admin QA Planted" });
    await services.memberships.commandHandler({
      streamId: "identity.membership-mbr_admin_qa_owner_planted",
      command: {
        type: "GrantMembership",
        membershipId: "mbr_admin_qa_owner_planted" as MembershipId,
        userId: "usr_admin_qa_owner" as UserId,
        accountId: "acc_admin_qa_planted" as AccountId,
        roleKey: "owner",
        assignmentAuthority: { type: "system" },
      },
      context: createIdentityBootstrapContext(),
    });
    await expect(aliasesWithSeveralMemberships()).resolves.toEqual(["admin-qa-owner", VIEWER]);
  });

  /** Every active-or-not Membership granted to an Admin QA User, joined to its Account, from stream state. */
  async function membershipEnumeration() {
    const granted = await pools.identity.query<{ stream_id: string }>(
      `SELECT stream_id FROM event_store_events
        WHERE event_type = 'identity.membership.granted' AND payload->>'userId' LIKE 'usr\\_admin\\_qa\\_%'`,
    );
    const rows = [];
    for (const { stream_id } of granted.rows) {
      const membership = (await services.memberships.getMembershipState(
        stream_id.slice("identity.membership-".length),
      ))!;
      const account = (await services.accounts.getAccountState(membership.accountId!))!;
      const fixture = ADMIN_QA_ACTOR_FIXTURES.find((candidate) => candidate.userId === membership.userId);
      rows.push({
        actorAlias: fixture?.actorAlias ?? "unknown",
        userId: membership.userId,
        membershipId: membership.id,
        accountId: membership.accountId,
        accountName: account.name,
        displayName: account.displayName,
        roleKey: membership.roleKey,
        membershipStatus: membership.status,
        accountStatus: account.status,
      });
    }
    return rows.sort(byMembership);
  }
  async function aliasesWithSeveralMemberships() {
    const counts = new Map<string, number>();
    for (const row of await membershipEnumeration()) {
      if (row.membershipStatus === "active") counts.set(row.actorAlias, (counts.get(row.actorAlias) ?? 0) + 1);
    }
    return [...counts]
      .filter(([, count]) => count > 1)
      .map(([alias]) => alias)
      .sort();
  }

  async function eventTypes(streamId: string) {
    return (await services.eventStore!.readStream({ streamId })).map((event) => event.eventType);
  }
  async function createAccount(
    accountId: string,
    overrides: Partial<{ accountId: string; name: string; accountType: "business" | "personal" }> = {},
  ) {
    const fixture = ADMIN_QA_ACTOR_FIXTURES.find((candidate) => candidate.accountId === accountId);
    const name = overrides.name ?? fixture?.accountName ?? accountId;
    await services.accounts.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: {
        type: "CreateAccount",
        accountId: (overrides.accountId ?? accountId) as AccountId,
        name,
        accountType: overrides.accountType ?? "business",
        displayName: name,
      },
      context: createIdentityBootstrapContext(),
    });
  }
  async function accountCommand(
    accountId: string,
    command: Parameters<IdentityServices["accounts"]["commandHandler"]>[0]["command"],
  ) {
    await services.accounts.commandHandler({
      streamId: `identity.account-${accountId}`,
      command,
      context: createIdentityBootstrapContext(),
    });
  }
  async function createUser(alias: string, overrides: Partial<{ userId: string; email: string }> = {}) {
    const fixture = fixtureOf(alias);
    const email = overrides.email ?? emailOf(alias);
    await services.users.commandHandler({
      streamId: `identity.user-${fixture.userId}`,
      command: {
        type: "CreateUser",
        userId: (overrides.userId ?? fixture.userId) as UserId,
        displayName: fixture.displayName,
        primaryEmail: email,
        givenName: fixture.givenName,
        familyName: fixture.familyName,
        primaryContactMethod: {
          contactMethodId: `ctm_${fixture.userId.slice(4)}_email`,
          type: "email",
          value: email,
          verifiedAt: "2026-07-13T00:00:00.000Z",
        },
      },
      context: createIdentityBootstrapContext(),
    });
  }
  async function userCommand(
    alias: string,
    command: Parameters<IdentityServices["users"]["commandHandler"]>[0]["command"],
  ) {
    await services.users.commandHandler({
      streamId: `identity.user-${fixtureOf(alias).userId}`,
      command,
      context: createIdentityBootstrapContext(),
    });
  }
  async function grant(alias: string, overrides: Partial<{ roleKey: string; accountId: string; userId: string }> = {}) {
    const fixture = fixtureOf(alias);
    await services.memberships.commandHandler({
      streamId: `identity.membership-${fixture.membershipId}`,
      command: {
        type: "GrantMembership",
        membershipId: fixture.membershipId,
        userId: (overrides.userId ?? fixture.userId) as UserId,
        accountId: (overrides.accountId ?? fixture.accountId) as AccountId,
        roleKey: (overrides.roleKey ?? fixture.roleKey) as typeof fixture.roleKey,
        assignmentAuthority: { type: "system" },
      },
      context: createIdentityBootstrapContext(),
    });
  }
  async function grantSecondary(overrides: Partial<{ roleKey: string; accountId: string }>) {
    await services.memberships.commandHandler({
      streamId: SECONDARY_MEMBERSHIP,
      command: {
        type: "GrantMembership",
        membershipId: "mbr_admin_qa_viewer_secondary" as MembershipId,
        userId: "usr_admin_qa_viewer" as UserId,
        accountId: (overrides.accountId ?? "acc_admin_qa_viewer_secondary") as AccountId,
        roleKey: (overrides.roleKey ?? "viewer") as "viewer",
        assignmentAuthority: { type: "system" },
      },
      context: createIdentityBootstrapContext(),
    });
  }
  async function appendRaw(
    streamId: string,
    events: ReadonlyArray<Readonly<{ eventType: string; payload: unknown }>>,
    expectedVersion: number | "no_stream" = "no_stream",
  ) {
    await services.eventStore!.appendToStream({
      streamId,
      expectedVersion,
      context: createIdentityBootstrapContext(),
      events: events as never,
    });
  }

  /** Lets `appended` commands for one alias through, then fails its next command. */
  function interruptAfter(base: IdentityServices, alias: string, appended: number): IdentityServices {
    const owned = new Set(Object.keys(cleanRun(alias)));
    let seen = 0;
    const guard =
      <Input extends { streamId: string }, Output>(handler: (input: Input) => Promise<Output>) =>
      async (input: Input) => {
        if (owned.has(input.streamId) && ++seen > appended) throw new Error("synthetic interruption");
        return handler(input);
      };
    return {
      ...base,
      accounts: { ...base.accounts, commandHandler: guard(base.accounts.commandHandler) },
      users: { ...base.users, commandHandler: guard(base.users.commandHandler) },
      memberships: { ...base.memberships, commandHandler: guard(base.memberships.commandHandler) },
    };
  }
  function failingRead(base: IdentityServices, streamId: string): IdentityServices {
    const eventStore = base.eventStore!;
    return {
      ...base,
      eventStore: {
        ...eventStore,
        readStream: async (input: Parameters<EventStore["readStream"]>[0]) => {
          if (input.streamId === streamId) throw new Error("synthetic read failure");
          return eventStore.readStream(input);
        },
      },
    };
  }
  function gappedRead(base: IdentityServices, streamId: string): IdentityServices {
    const eventStore = base.eventStore!;
    return {
      ...base,
      eventStore: {
        ...eventStore,
        readStream: async (input: Parameters<EventStore["readStream"]>[0]) => {
          const page = await eventStore.readStream(input);
          if (input.streamId !== streamId) return page;
          return page.map((event) => ({ ...event, streamVersion: event.streamVersion + 1 }));
        },
      },
    };
  }
});

function byMembership(left: { membershipId: unknown }, right: { membershipId: unknown }) {
  return String(left.membershipId).localeCompare(String(right.membershipId));
}
