import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { assertBoundedStreamReadContract } from "@chase-sets/event-core/test-support";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres/schema";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createId } from "@chase-sets/primitives/typed-ids";
import { buildIdentityApi } from "../api";
import { createAccountRuntime } from "../features/accounts/api/runtime";
import { createConsentRuntime } from "../features/consents/api/runtime";
import { createMembershipRuntime } from "../features/memberships/api/runtime";
import { createUserRuntime } from "../features/users/api/runtime";
import { identityAccountSchemaSql } from "../features/accounts/read-model/schema";
import {
  mintRegistrationConsentResolution,
  type RegistrationConsentRequirement,
} from "../features/consents/domain/registration-consent";
import { createBootstrapContext } from "../api";
import {
  deriveRegistrationOperation,
  REGISTRATION_OPERATION_CLAIMED_EVENT_TYPE,
  REGISTRATION_OPERATION_KEY_VERSION,
  type RegistrationOperationClaim,
} from "../support/runtime-support/registration-operation";
import { resolveRegistrationConsentSigningKeys } from "../support/runtime-support/registration-consent-signing";
import type { IdentityServices } from "../support/runtime-support/services";
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import {
  activateRealConsentAuthority,
  activatedMembersFor,
  fixtureRegistrationConsentBundleResolver,
  recordingAuthorityReaderOver,
  type FixtureRegistrationConsentBundleResolver,
  type RecordingAuthorityReader,
} from "./consent-activation-authority-fixtures";

// Exercised against a real Postgres sandbox, never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["identity"] as const;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for database-backed tests.");
  }
  return databaseBaseUrl;
}

const EMAIL = "owner@pokebash.example";
const DISPLAY_NAME = "PokeBash TCG";
const DISPLAY_NAME_KEY = "pokebash tcg";
const strandedAccountStreamReadContractSiteId = "bounded-contexts/identity/api.ts#readStream#1";

const TERMS_V1: RegistrationConsentRequirement = { policyKey: "terms-of-service", version: "v1", href: "/terms" };
const TERMS_V2: RegistrationConsentRequirement = { policyKey: "terms-of-service", version: "v2", href: "/terms" };
const PRIVACY_V3: RegistrationConsentRequirement = { policyKey: "privacy-policy", version: "v3", href: "/privacy" };

describeDb("registration operation recovery", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;
  let eventStore: EventStore;
  let services: IdentityServices;
  let registrationConsentBundles: FixtureRegistrationConsentBundleResolver;
  let policies: PolicyRuntime;
  let authorityReader: RecordingAuthorityReader;
  const context: EventStoreContext = createBootstrapContext();

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      contextNames,
      "identity_registration_recovery",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.identity;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ identity: pool });
    await pool.query(eventCorePostgresSchemaSql);
    await pool.query(identityAccountSchemaSql);

    eventStore = createPostgresEventStore({ pool });
    const deps = {
      eventStore,
      checkpointStore: createPostgresProjectionStore({ db: pool }),
      db: pool,
    } as const;
    // The bundle resolves against the REAL Consent Activation Authority in this
    // database, so every guard it retains is a revision PostgreSQL actually
    // holds. Only the publication half is a fixture, because the shipped corpus
    // compiles nothing as consent-activatable.
    policies = createPolicyRuntime({ eventStore, db: pool });
    authorityReader = recordingAuthorityReaderOver(policies.consentActivation);
    registrationConsentBundles = fixtureRegistrationConsentBundleResolver([], { authority: authorityReader });
    services = {
      eventStore,
      db: pool,
      accounts: createAccountRuntime(deps),
      users: createUserRuntime(deps),
      memberships: createMembershipRuntime(deps),
      consents: createConsentRuntime(deps),
      registrationConsentBundles,
      policies,
      projectors: [],
    } as unknown as IdentityServices;
  });

  /** Activate the given members on the real authority and make them publication-eligible. */
  async function activateBundle(bundle: readonly RegistrationConsentRequirement[]) {
    const members = activatedMembersFor(bundle);
    for (const member of members) {
      await activateRealConsentAuthority(policies.consentActivation, context, member);
    }
    registrationConsentBundles.activate(members);
  }

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  /**
   * Submits `bundle` as the signed resolution. What the CURRENT bundle derives
   * is a separate input, set by `activateBundle`, so a case can move one
   * without moving the other.
   */
  async function register(bundle: readonly RegistrationConsentRequirement[], body: Record<string, unknown> = {}) {
    const response = await buildIdentityApi(services).request("/internal/auth/personal-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: EMAIL,
        displayName: DISPLAY_NAME,
        registrationConsent: {
          resolution: mintRegistrationConsentResolution({
            requirements: bundle,
            resolvedAt: new Date().toISOString(),
            signingKeys: resolveRegistrationConsentSigningKeys(),
          }),
          affirmed: true,
        },
        ...body,
      }),
    });

    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  function operationFor(email: string) {
    const operation = deriveRegistrationOperation({ email });
    if (!operation) {
      throw new Error("The test contact must derive a registration operation.");
    }
    return operation;
  }

  /**
   * Write a partially-registered identity the way a pre-atomic sequence left
   * one behind: the operation claim plus only the participants that had already
   * committed when the sequence died. Written as a direct append rather than by
   * replaying the removed sequential composition, which is what the recovering
   * request has to complete.
   */
  async function writePartialRegistration(
    bundle: readonly RegistrationConsentRequirement[],
    committed: Readonly<{ account?: boolean; user?: boolean; membership?: boolean; consents?: number }>,
  ) {
    const operation = operationFor(EMAIL);
    const accountId = createId("acc");
    const userId = createId("usr");
    const membershipId = createId("mbr");
    const consents = bundle.map((requirement) => ({
      consentId: createId("cns"),
      policyKey: requirement.policyKey,
      policyVersion: requirement.version,
    }));

    const claim: RegistrationOperationClaim = {
      operationKeyDigest: operation.keyDigest,
      operationKeyVersion: REGISTRATION_OPERATION_KEY_VERSION,
      contactType: "email",
      accountId: accountId as never,
      userId: userId as never,
      membershipId: membershipId as never,
      displayName: DISPLAY_NAME,
      displayNameKey: DISPLAY_NAME_KEY,
      consents: consents as never,
      claimedAt: new Date().toISOString(),
    };

    await eventStore.appendToStream({
      streamId: operation.streamId,
      expectedVersion: "no_stream",
      events: [{ eventType: REGISTRATION_OPERATION_CLAIMED_EVENT_TYPE, payload: claim as never }],
      context,
    });

    if (committed.account) {
      await eventStore.appendToStream({
        streamId: `identity.account-${accountId}`,
        expectedVersion: "no_stream",
        events: [
          {
            eventType: "identity.account.created",
            payload: { accountId, name: "", accountType: "personal", displayName: DISPLAY_NAME },
          },
        ],
        context,
      });
    }
    if (committed.user) {
      await eventStore.appendToStream({
        streamId: `identity.user-${userId}`,
        expectedVersion: "no_stream",
        events: [
          {
            eventType: "identity.user.created",
            payload: {
              userId,
              displayName: DISPLAY_NAME,
              givenName: "",
              familyName: "",
              primaryEmail: EMAIL,
              primaryContactMethod: {
                contactMethodId: `${userId}-primary-email`,
                type: "email",
                value: EMAIL,
                verifiedAt: null,
              },
            },
          },
        ],
        context,
      });
    }
    if (committed.membership) {
      await eventStore.appendToStream({
        streamId: `identity.membership-${membershipId}`,
        expectedVersion: "no_stream",
        events: [
          {
            eventType: "identity.membership.granted",
            payload: { membershipId, userId, accountId, roleKey: "owner" },
          },
        ],
        context,
      });
    }
    for (let index = 0; index < (committed.consents ?? 0); index += 1) {
      const consent = consents[index];
      await eventStore.appendToStream({
        streamId: `identity.consent-${consent.consentId}`,
        expectedVersion: "no_stream",
        events: [
          {
            eventType: "identity.consent.recorded",
            payload: {
              consentId: consent.consentId,
              subjectType: "user",
              userId,
              accountId,
              policyKey: consent.policyKey,
              policyVersion: consent.policyVersion,
              recordedAt: new Date().toISOString(),
            },
          },
        ],
        context,
      });
    }

    await pool.query(
      `INSERT INTO identity_account_display_name_reservations (
         display_name_key, account_id, display_name, operation_key, created_at
       ) VALUES ($1, $2, $3, $4, now())`,
      [DISPLAY_NAME_KEY, accountId, DISPLAY_NAME, operation.key],
    );

    return { accountId, userId, membershipId, consents };
  }

  async function streamIds(prefix: string) {
    const events = await eventStore.readAll({ limit: 500 });
    return [...new Set(events.filter((e: StoredEvent) => e.streamId.startsWith(prefix)).map((e) => e.streamId))];
  }

  const partialShapes = [
    ["account only", { account: true }],
    ["account and user", { account: true, user: true }],
    ["account, user and membership", { account: true, user: true, membership: true }],
    ["account, user, membership and the first consent", { account: true, user: true, membership: true, consents: 1 }],
  ] as const;

  it.each(partialShapes)("completes a pre-existing partial that had committed %s", async (_label, committed) => {
    const bundle = [TERMS_V1, PRIVACY_V3];
    await activateBundle(bundle);
    const partial = await writePartialRegistration(bundle, committed);

    const completed = await register(bundle);

    expect(completed.status).toBe(201);
    expect(completed.body.accountId, "completion must adopt the claimed ids, never mint new ones").toBe(
      partial.accountId,
    );
    expect(completed.body.userId).toBe(partial.userId);
    expect(completed.body.membershipId).toBe(partial.membershipId);

    expect(await streamIds("identity.account-")).toEqual([`identity.account-${partial.accountId}`]);
    expect(await streamIds("identity.user-")).toEqual([`identity.user-${partial.userId}`]);
    expect(await streamIds("identity.membership-")).toEqual([`identity.membership-${partial.membershipId}`]);
    expect(await streamIds("identity.consent-")).toHaveLength(bundle.length);
  });

  it.each([
    ["500-event boundary", 500],
    ["501-event history", 501],
  ] as const)(
    "issue-6299-acceptance-control completes registration recovery across the real PostgreSQL %s",
    async (_label, eventCount) => {
      await activateBundle([TERMS_V1]);
      const partial = await writePartialRegistration([TERMS_V1], { account: true });
      const accountStreamId = `identity.account-${partial.accountId}`;
      await eventStore.appendToStream({
        streamId: accountStreamId,
        expectedVersion: 1,
        context,
        events: Array.from({ length: eventCount - 1 }, () => ({
          eventType: "identity.account.profile-updated",
          payload: { name: "", displayName: DISPLAY_NAME },
        })),
      });

      const completed = await register([TERMS_V1]);

      expect(completed.status).toBe(201);
      expect(completed.body).toMatchObject({
        accountId: partial.accountId,
        userId: partial.userId,
        membershipId: partial.membershipId,
      });
      expect(await readCompleteStream(eventStore, { streamId: accountStreamId })).toHaveLength(eventCount);
      await expect(
        readCompleteStream(eventStore, { streamId: `identity.user-${partial.userId}` }),
      ).resolves.toHaveLength(1);
      await expect(
        readCompleteStream(eventStore, { streamId: `identity.membership-${partial.membershipId}` }),
      ).resolves.toHaveLength(1);
      await expect(
        readCompleteStream(eventStore, { streamId: `identity.consent-${partial.consents[0]?.consentId}` }),
      ).resolves.toHaveLength(1);
    },
  );

  it("appends nothing and fails closed when the claimed bundle disagrees on a policy version", async () => {
    await activateBundle([TERMS_V1, PRIVACY_V3]);
    const partial = await writePartialRegistration([TERMS_V1, PRIVACY_V3], { account: true });
    const before = await eventStore.readAll({ limit: 500 });

    const disagreed = await register([TERMS_V2, PRIVACY_V3]);

    expect(disagreed.status).toBe(409);
    expect((disagreed.body.error as { code?: string } | undefined)?.code).toBe(
      "registration_operation_consent_disagreement",
    );
    const after = await eventStore.readAll({ limit: 500 });
    expect(after.length, "a version disagreement must append nothing").toBe(before.length);
    expect(await streamIds("identity.user-")).toEqual([]);
    expect(await streamIds("identity.membership-")).toEqual([]);
    expect(await streamIds("identity.consent-")).toEqual([]);
    expect(partial.accountId).toBeDefined();
  });

  it("appends nothing when the claimed bundle disagrees on requirement count", async () => {
    await activateBundle([TERMS_V1, PRIVACY_V3]);
    await writePartialRegistration([TERMS_V1, PRIVACY_V3], { account: true });
    const before = await eventStore.readAll({ limit: 500 });

    const disagreed = await register([TERMS_V1]);

    expect(disagreed.status).toBe(409);
    expect(await eventStore.readAll({ limit: 500 })).toHaveLength(before.length);
  });

  it("reclaims a reservation left behind before operations were recorded, when its account never committed", async () => {
    await activateBundle([TERMS_V1]);
    await pool.query(
      `INSERT INTO identity_account_display_name_reservations (
         display_name_key, account_id, display_name, operation_key, created_at
       ) VALUES ($1, $2, $3, NULL, now())`,
      [DISPLAY_NAME_KEY, "acc_stranded_never_committed", DISPLAY_NAME],
    );

    const registered = await register([TERMS_V1]);

    expect(registered.status, "a stranded pre-operation reservation must not block registration").toBe(201);
    const reservations = await pool.query<{ account_id: string; operation_key: string | null }>(
      "SELECT account_id, operation_key FROM identity_account_display_name_reservations",
    );
    expect(reservations.rows).toEqual([
      { account_id: registered.body.accountId, operation_key: operationFor(EMAIL).key },
    ]);
  });

  it(`${strandedAccountStreamReadContractSiteId} refuses to adopt a pre-operation reservation whose account really exists`, async () => {
    await activateBundle([TERMS_V1]);
    const liveAccountId = createId("acc");
    await eventStore.appendToStream({
      streamId: `identity.account-${liveAccountId}`,
      expectedVersion: "no_stream",
      events: [
        {
          eventType: "identity.account.created",
          payload: { accountId: liveAccountId, name: "", accountType: "personal", displayName: DISPLAY_NAME },
        },
        {
          eventType: "identity.account.profile-updated",
          payload: { name: "", displayName: DISPLAY_NAME },
        },
      ],
      context,
    });
    await pool.query(
      `INSERT INTO identity_account_display_name_reservations (
         display_name_key, account_id, display_name, operation_key, created_at
       ) VALUES ($1, $2, $3, NULL, now())`,
      [DISPLAY_NAME_KEY, liveAccountId, DISPLAY_NAME],
    );

    const readStream = vi.spyOn(eventStore, "readStream");
    const blocked = await register([TERMS_V1]);

    expect(blocked.status, "adopting a live account would grant a stranger an owner membership on it").toBe(409);
    expect((blocked.body.error as { code?: string } | undefined)?.code).toBe("display_name_already_taken");
    expect(await streamIds("identity.user-")).toEqual([]);
    expect(await streamIds("identity.membership-")).toEqual([]);
    assertBoundedStreamReadContract({
      streamId: `identity.account-${liveAccountId}`,
      bound: 1,
      historyLength: 2,
      requests: readStream.mock.calls
        .map(([request]) => request)
        .filter((request) => request.streamId === `identity.account-${liveAccountId}`),
    });
  });

  it("rejects a registration that carries no verified contact at all", async () => {
    await activateBundle([TERMS_V1]);
    const contactless = await register([TERMS_V1], { email: null, phone: null });

    expect(contactless.status).toBe(400);
    expect((contactless.body.error as { code?: string } | undefined)?.code).toBe(
      "registration_operation_contact_required",
    );
    expect(await streamIds("identity.account-")).toEqual([]);
    expect(await streamIds("identity.registration-operation-")).toEqual([]);
  });

  /**
   * The complete-committed-recovery contract, asserted at the exact lifecycle
   * moment it holds: after complete claim and participant histories establish
   * that every participant already committed.
   *
   * All five facts are pinned together because each one alone is satisfiable by
   * a wrong implementation. Returning early satisfies "zero appended events"
   * and "zero authority reads" while dropping every participant guard, and
   * dropping one participant guard satisfies "exactly one invocation" while
   * leaving that aggregate unguarded. The two mutants below are exactly those
   * two implementations.
   */
  it("retains every participant version guard on complete committed recovery", async () => {
    const bundle = [TERMS_V1, PRIVACY_V3];
    await activateBundle(bundle);

    const first = await register(bundle);
    expect(first.status, "the first registration must commit every participant").toBe(201);

    const appendToStreams = vi.spyOn(eventStore, "appendToStreams");
    const readsBefore = authorityReader.reads.length;
    const resolvesBefore = registrationConsentBundles.resolveCount();
    const eventsBefore = await eventStore.readAll({ limit: 1000 });

    const recovered = await register(bundle);

    // 201 with the winner's ids.
    expect(recovered.status).toBe(201);
    expect(recovered.body.accountId).toBe(first.body.accountId);
    expect(recovered.body.userId).toBe(first.body.userId);
    expect(recovered.body.membershipId).toBe(first.body.membershipId);

    // Zero authority reads: everything is committed, so there is no version
    // whose activation could still change.
    expect(authorityReader.reads.length - readsBefore, "a complete recovery reads no activation authority").toBe(0);
    expect(registrationConsentBundles.resolveCount() - resolvesBefore, "and resolves no bundle").toBe(0);

    // Exactly one `appendToStreams` invocation, and it must have happened --
    // returning before it is the first bypass this pins.
    expect(appendToStreams).toHaveBeenCalledTimes(1);
    const inputs = appendToStreams.mock.calls[0]?.[0] ?? [];

    // Its batch is exactly the existing participants, one guard each.
    const operation = operationFor(EMAIL);
    const consentStreamIds = (await streamIds("identity.consent-")).sort();
    expect([...inputs].map((input) => input.streamId).sort()).toEqual(
      [
        operation.streamId,
        `identity.account-${first.body.accountId}`,
        `identity.user-${first.body.userId}`,
        `identity.membership-${first.body.membershipId}`,
        ...consentStreamIds,
      ].sort(),
    );
    expect(inputs).toHaveLength(4 + bundle.length);

    // Every input is a pure version guard...
    for (const input of inputs) {
      expect(input.events, `${input.streamId} must carry no events`).toEqual([]);
      expect(input.expectedVersion, `${input.streamId} must guard a committed version`).not.toBe("any");
    }

    // ...and nothing was appended.
    const eventsAfter = await eventStore.readAll({ limit: 1000 });
    expect(eventsAfter.length - eventsBefore.length, "a complete recovery appends no event").toBe(0);

    appendToStreams.mockRestore();
  });

  it("converges an email that differs only by casing and surrounding whitespace", async () => {
    await activateBundle([TERMS_V1]);
    const first = await register([TERMS_V1], { email: EMAIL });
    const second = await register([TERMS_V1], { email: `  ${EMAIL.toUpperCase()}  ` });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.accountId, "normalization must not mint a second account").toBe(first.body.accountId);
    expect(await streamIds("identity.account-")).toHaveLength(1);
  });
});
