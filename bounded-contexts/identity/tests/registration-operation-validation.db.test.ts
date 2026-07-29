import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
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
import { buildIdentityApi, createBootstrapContext } from "../api";
import { createAccountRuntime } from "../features/accounts/api/runtime";
import { createConsentRuntime } from "../features/consents/api/runtime";
import { createMembershipRuntime } from "../features/memberships/api/runtime";
import { createUserRuntime } from "../features/users/api/runtime";
import { identityAccountSchemaSql } from "../features/accounts/read-model/schema";
import {
  mintRegistrationConsentResolution,
  type RegistrationConsentRequirement,
} from "../features/consents/domain/registration-consent";
import {
  deriveRegistrationOperation,
  REGISTRATION_OPERATION_CLAIMED_EVENT_TYPE,
  REGISTRATION_OPERATION_KEY_VERSION,
  type RegistrationOperation,
  type RegistrationOperationClaim,
} from "../support/runtime-support/registration-operation";
import { resolveRegistrationConsentSigningKeys } from "../support/runtime-support/registration-consent-signing";
import type { IdentityServices } from "../support/runtime-support/services";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["identity"] as const;
const EVENT_STORE_READ_PAGE_SIZE = 500;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for database-backed tests.");
  }
  return databaseBaseUrl;
}

const EMAIL = "owner@pokebash.example";
const DISPLAY_NAME = "PokeBash TCG";
const DISPLAY_NAME_KEY = "pokebash tcg";
const TERMS_V1: RegistrationConsentRequirement = {
  policyKey: "terms-of-service",
  version: "v1",
  href: "/terms",
};
const PRIVACY_V3: RegistrationConsentRequirement = {
  policyKey: "privacy-policy",
  version: "v3",
  href: "/privacy",
};

type Fixture = Readonly<{
  operation: RegistrationOperation;
  claim: RegistrationOperationClaim;
  accountId: string;
  userId: string;
  membershipId: string;
  consentId: string;
}>;

type EventSeed = Readonly<{ eventType: string; payload: Readonly<Record<string, unknown>> }>;

describeDb("registration operation semantic validation", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;
  let eventStore: EventStore;
  let services: IdentityServices;
  const context: EventStoreContext = createBootstrapContext();

  function createServices(store: EventStore): IdentityServices {
    const dependencies = {
      eventStore: store,
      checkpointStore: createPostgresProjectionStore({ db: pool }),
      db: pool,
    } as const;
    return {
      eventStore: store,
      db: pool,
      accounts: createAccountRuntime(dependencies),
      users: createUserRuntime(dependencies),
      memberships: createMembershipRuntime(dependencies),
      consents: createConsentRuntime(dependencies),
      projectors: [],
    } as unknown as IdentityServices;
  }

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      contextNames,
      "identity_registration_validation",
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
    services = createServices(eventStore);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  async function register(
    body: Record<string, unknown> = {},
    requirements: readonly RegistrationConsentRequirement[] = [TERMS_V1],
  ) {
    const response = await buildIdentityApi(services).request("/internal/auth/personal-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: EMAIL,
        displayName: DISPLAY_NAME,
        registrationConsent: {
          resolution: mintRegistrationConsentResolution({
            requirements,
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

  function operationFor(email = EMAIL): RegistrationOperation {
    const operation = deriveRegistrationOperation({ email });
    if (!operation) {
      throw new Error("The test contact must derive a registration operation.");
    }
    return operation;
  }

  function createFixtureClaim(
    operation: RegistrationOperation,
    overrides: Readonly<Record<string, unknown>> = {},
  ): Fixture {
    const accountId = createId("acc");
    const userId = createId("usr");
    const membershipId = createId("mbr");
    const consentId = createId("cns");
    const claim = {
      operationKeyDigest: operation.keyDigest,
      operationKeyVersion: REGISTRATION_OPERATION_KEY_VERSION,
      contactType: operation.contactType,
      accountId,
      userId,
      membershipId,
      displayName: DISPLAY_NAME,
      displayNameKey: DISPLAY_NAME_KEY,
      consents: [{ consentId, policyKey: TERMS_V1.policyKey, policyVersion: TERMS_V1.version }],
      claimedAt: new Date().toISOString(),
      ...overrides,
    } as unknown as RegistrationOperationClaim;
    return { operation, claim, accountId, userId, membershipId, consentId };
  }

  async function appendEvents(streamId: string, events: readonly EventSeed[]) {
    await eventStore.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      events: events.map((event) => ({ eventType: event.eventType, payload: event.payload as never })),
      context,
    });
  }

  async function seedClaimedFixture(
    options: Readonly<{
      claimOverrides?: Readonly<Record<string, unknown>>;
      claimTail?: "repeated" | "unexpected";
      seedReservation?: boolean;
    }> = {},
  ): Promise<Fixture> {
    const fixture = createFixtureClaim(operationFor(), options.claimOverrides);
    const claimEvents: EventSeed[] = [
      { eventType: REGISTRATION_OPERATION_CLAIMED_EVENT_TYPE, payload: fixture.claim as never },
    ];
    if (options.claimTail === "repeated") {
      claimEvents.push({ eventType: REGISTRATION_OPERATION_CLAIMED_EVENT_TYPE, payload: fixture.claim as never });
    }
    if (options.claimTail === "unexpected") {
      claimEvents.push({ eventType: "identity.registration-operation.reopened", payload: {} });
    }
    await appendEvents(fixture.operation.streamId, claimEvents);

    if (options.seedReservation !== false) {
      await pool.query(
        `INSERT INTO identity_account_display_name_reservations (
           display_name_key, account_id, display_name, operation_key, created_at
         ) VALUES ($1, $2, $3, $4, now())`,
        [DISPLAY_NAME_KEY, fixture.accountId, DISPLAY_NAME, fixture.operation.key],
      );
    }
    return fixture;
  }

  function accountCreated(fixture: Fixture, overrides: Readonly<Record<string, unknown>> = {}): EventSeed {
    return {
      eventType: "identity.account.created",
      payload: {
        accountId: fixture.accountId,
        name: "",
        accountType: "personal",
        displayName: DISPLAY_NAME,
        ...overrides,
      },
    };
  }

  function userCreated(fixture: Fixture, overrides: Readonly<Record<string, unknown>> = {}): EventSeed {
    return {
      eventType: "identity.user.created",
      payload: {
        userId: fixture.userId,
        displayName: DISPLAY_NAME,
        givenName: "",
        familyName: "",
        primaryEmail: EMAIL,
        primaryContactMethod: {
          contactMethodId: `${fixture.userId}-primary-email`,
          type: "email",
          value: EMAIL,
          verifiedAt: null,
        },
        ...overrides,
      },
    };
  }

  function membershipGranted(fixture: Fixture, overrides: Readonly<Record<string, unknown>> = {}): EventSeed {
    return {
      eventType: "identity.membership.granted",
      payload: {
        membershipId: fixture.membershipId,
        userId: fixture.userId,
        accountId: fixture.accountId,
        roleKey: "owner",
        ...overrides,
      },
    };
  }

  function consentRecorded(fixture: Fixture, overrides: Readonly<Record<string, unknown>> = {}): EventSeed {
    return {
      eventType: "identity.consent.recorded",
      payload: {
        consentId: fixture.consentId,
        subjectType: "user",
        userId: fixture.userId,
        accountId: fixture.accountId,
        policyKey: TERMS_V1.policyKey,
        policyVersion: TERMS_V1.version,
        recordedAt: new Date().toISOString(),
        ...overrides,
      },
    };
  }

  async function readCompleteEventHistory(): Promise<readonly StoredEvent[]> {
    const events: StoredEvent[] = [];
    let afterGlobalPosition: StoredEvent["globalPosition"] | undefined;

    while (true) {
      const page = await eventStore.readAll({
        limit: EVENT_STORE_READ_PAGE_SIZE,
        ...(afterGlobalPosition ? { afterGlobalPosition } : {}),
      });
      events.push(...page);

      if (page.length < EVENT_STORE_READ_PAGE_SIZE) {
        return events;
      }

      const lastEvent = page.at(-1);
      if (!lastEvent) {
        throw new Error("A full event-store page must have a final event.");
      }
      afterGlobalPosition = lastEvent.globalPosition;
    }
  }

  async function stateSnapshot() {
    const events = (await readCompleteEventHistory()).map((event) => ({
      eventId: event.eventId,
      streamId: event.streamId,
      streamVersion: event.streamVersion,
      eventType: event.eventType,
      payload: event.payload,
    }));
    const reservations = await pool.query<{
      display_name_key: string;
      account_id: string;
      display_name: string;
      operation_key: string | null;
    }>(
      `SELECT display_name_key, account_id, display_name, operation_key
       FROM identity_account_display_name_reservations
       ORDER BY display_name_key`,
    );
    return { events, reservations: reservations.rows };
  }

  async function expectRejectedWithoutMutation(code: string) {
    const before = await stateSnapshot();
    const response = await register();
    expect(response.status).toBe(409);
    expect((response.body.error as { code?: string } | undefined)?.code).toBe(code);
    expect(await stateSnapshot()).toEqual(before);
  }

  const claimDisagreements = [
    ["operation key digest", { operationKeyDigest: "0".repeat(64) }, undefined],
    ["operation key version", { operationKeyVersion: "v0" }, undefined],
    ["contact type", { contactType: "phone" }, undefined],
    ["display-name key metadata", { displayNameKey: "different" }, undefined],
    ["a repeated claim event", {}, "repeated"],
    ["an unexpected claim event", {}, "unexpected"],
  ] as const;

  it.each(claimDisagreements)("rejects poisoned claim history: %s", async (_label, claimOverrides, claimTail) => {
    await seedClaimedFixture({
      claimOverrides,
      ...(claimTail ? { claimTail } : {}),
    });
    await expectRejectedWithoutMutation("registration_operation_participant_disagreement");
  });

  const participantDisagreements: readonly Readonly<{
    label: string;
    code: "registration_operation_participant_disagreement" | "registration_operation_consent_disagreement";
    seed: (fixture: Fixture) => Promise<void>;
  }>[] = [
    {
      label: "closed Account",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.account-${fixture.accountId}`, [
          accountCreated(fixture),
          { eventType: "identity.account.closed", payload: {} },
        ]),
    },
    {
      label: "suspended Account",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.account-${fixture.accountId}`, [
          accountCreated(fixture),
          { eventType: "identity.account.suspended", payload: {} },
        ]),
    },
    {
      label: "closed Account followed by a poisoned reactivation",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.account-${fixture.accountId}`, [
          accountCreated(fixture),
          { eventType: "identity.account.closed", payload: {} },
          { eventType: "identity.account.reactivated", payload: {} },
        ]),
    },
    {
      label: "non-personal Account",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.account-${fixture.accountId}`, [accountCreated(fixture, { accountType: "business" })]),
    },
    {
      label: "Account display name foreign to the claim",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.account-${fixture.accountId}`, [
          accountCreated(fixture, { displayName: "Foreign Account" }),
        ]),
    },
    {
      label: "Account creation metadata is incomplete",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.account-${fixture.accountId}`, [accountCreated(fixture, { name: null })]),
    },
    {
      label: "Account id foreign to the claim",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.account-${fixture.accountId}`, [
          accountCreated(fixture, { accountId: createId("acc") }),
        ]),
    },
    {
      label: "draft Account history",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.account-${fixture.accountId}`, [
          {
            eventType: "identity.account.profile-updated",
            payload: { name: "", displayName: DISPLAY_NAME },
          },
        ]),
    },
    {
      label: "repeated Account creation",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.account-${fixture.accountId}`, [accountCreated(fixture), accountCreated(fixture)]),
    },
    {
      label: "unexpected Account event",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.account-${fixture.accountId}`, [
          accountCreated(fixture),
          { eventType: "identity.account.promoted", payload: {} },
        ]),
    },
    {
      label: "suspended User",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.user-${fixture.userId}`, [
          userCreated(fixture),
          { eventType: "identity.user.suspended", payload: {} },
        ]),
    },
    {
      label: "User contact foreign to the operation",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.user-${fixture.userId}`, [
          userCreated(fixture, {
            primaryEmail: "somebody-else@pokebash.example",
            primaryContactMethod: {
              contactMethodId: `${fixture.userId}-primary-email`,
              type: "email",
              value: "somebody-else@pokebash.example",
              verifiedAt: null,
            },
          }),
        ]),
    },
    {
      label: "User primary-contact metadata conflicts with its recorded email",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.user-${fixture.userId}`, [
          userCreated(fixture, {
            primaryContactMethod: {
              contactMethodId: `${fixture.userId}-primary-phone`,
              type: "phone",
              value: "+15555550123",
              verifiedAt: new Date().toISOString(),
            },
          }),
        ]),
    },
    {
      label: "User id foreign to the claim",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.user-${fixture.userId}`, [userCreated(fixture, { userId: createId("usr") })]),
    },
    {
      label: "revoked Membership",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.membership-${fixture.membershipId}`, [
          membershipGranted(fixture),
          { eventType: "identity.membership.revoked", payload: {} },
        ]),
    },
    {
      label: "non-owner Membership",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.membership-${fixture.membershipId}`, [
          membershipGranted(fixture, { roleKey: "viewer" }),
        ]),
    },
    {
      label: "Membership user foreign to the claim",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.membership-${fixture.membershipId}`, [
          membershipGranted(fixture, { userId: createId("usr") }),
        ]),
    },
    {
      label: "Membership id foreign to the claim",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.membership-${fixture.membershipId}`, [
          membershipGranted(fixture, { membershipId: createId("mbr") }),
        ]),
    },
    {
      label: "Membership account foreign to the claim",
      code: "registration_operation_participant_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.membership-${fixture.membershipId}`, [
          membershipGranted(fixture, { accountId: createId("acc") }),
        ]),
    },
    {
      label: "Consent policy version foreign to the claim",
      code: "registration_operation_consent_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.consent-${fixture.consentId}`, [consentRecorded(fixture, { policyVersion: "v2" })]),
    },
    {
      label: "Consent policy key foreign to the claim",
      code: "registration_operation_consent_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.consent-${fixture.consentId}`, [
          consentRecorded(fixture, { policyKey: "privacy-policy" }),
        ]),
    },
    {
      label: "Consent id foreign to the claim",
      code: "registration_operation_consent_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.consent-${fixture.consentId}`, [
          consentRecorded(fixture, { consentId: createId("cns") }),
        ]),
    },
    {
      label: "Consent subject type is not user",
      code: "registration_operation_consent_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.consent-${fixture.consentId}`, [
          consentRecorded(fixture, { subjectType: "account", userId: null }),
        ]),
    },
    {
      label: "Consent user foreign to the claim",
      code: "registration_operation_consent_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.consent-${fixture.consentId}`, [consentRecorded(fixture, { userId: createId("usr") })]),
    },
    {
      label: "Consent account foreign to the claim",
      code: "registration_operation_consent_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.consent-${fixture.consentId}`, [
          consentRecorded(fixture, { accountId: createId("acc") }),
        ]),
    },
    {
      label: "Consent with invalid recorded metadata",
      code: "registration_operation_consent_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.consent-${fixture.consentId}`, [
          consentRecorded(fixture, { recordedAt: "not-an-instant" }),
        ]),
    },
    {
      label: "withdrawn Consent",
      code: "registration_operation_consent_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.consent-${fixture.consentId}`, [
          consentRecorded(fixture),
          {
            eventType: "identity.consent.withdrawn",
            payload: {
              consentId: fixture.consentId,
              subjectType: "user",
              userId: fixture.userId,
              accountId: fixture.accountId,
              policyKey: TERMS_V1.policyKey,
              policyVersion: TERMS_V1.version,
              withdrawnAt: new Date().toISOString(),
            },
          },
        ]),
    },
    {
      label: "draft Consent history",
      code: "registration_operation_consent_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.consent-${fixture.consentId}`, [
          {
            eventType: "identity.consent.withdrawn",
            payload: {
              consentId: fixture.consentId,
              subjectType: "user",
              userId: fixture.userId,
              accountId: fixture.accountId,
              policyKey: TERMS_V1.policyKey,
              policyVersion: TERMS_V1.version,
              withdrawnAt: new Date().toISOString(),
            },
          },
        ]),
    },
    {
      label: "repeated Consent recording",
      code: "registration_operation_consent_disagreement",
      seed: (fixture) =>
        appendEvents(`identity.consent-${fixture.consentId}`, [consentRecorded(fixture), consentRecorded(fixture)]),
    },
  ];

  it.each(participantDisagreements)("rejects poisoned participant history: $label", async ({ code, seed }) => {
    const fixture = await seedClaimedFixture();
    await seed(fixture);
    await expectRejectedWithoutMutation(code);
  });

  it("treats every zero-event participant stream container as missing and completes it", async () => {
    const fixture = await seedClaimedFixture();
    const streamIds = [
      `identity.account-${fixture.accountId}`,
      `identity.user-${fixture.userId}`,
      `identity.membership-${fixture.membershipId}`,
      `identity.consent-${fixture.consentId}`,
    ];
    for (const streamId of streamIds) {
      await pool.query(
        `INSERT INTO event_store_streams (stream_id, current_version, updated_at)
         VALUES ($1, 0, now())`,
        [streamId],
      );
    }

    const completed = await register();

    expect(completed.status).toBe(201);
    expect(completed.body.accountId).toBe(fixture.accountId);
    for (const streamId of streamIds) {
      expect(await eventStore.readStream({ streamId })).toHaveLength(1);
    }
  });

  it("treats a zero-event Registration Operation stream container as unclaimed", async () => {
    const operation = operationFor();
    await pool.query(
      `INSERT INTO event_store_streams (stream_id, current_version, updated_at)
       VALUES ($1, 0, now())`,
      [operation.streamId],
    );

    const completed = await register();

    expect(completed.status).toBe(201);
    expect(await eventStore.readStream({ streamId: operation.streamId })).toHaveLength(1);
  });

  it("captures authoritative state beyond the first event-store page", async () => {
    await appendEvents(
      "identity.snapshot-pagination-control",
      Array.from({ length: 501 }, (_, ordinal) => ({
        eventType: "identity.snapshot-pagination-control.recorded",
        payload: { ordinal },
      })),
    );

    const snapshot = await stateSnapshot();

    expect(snapshot.events).toHaveLength(501);
    expect(snapshot.events.at(-1)).toMatchObject({
      streamId: "identity.snapshot-pagination-control",
      streamVersion: 501,
      payload: { ordinal: 500 },
    });
  });

  it("keeps the day-after steady state inert on the second and third calls", async () => {
    const inner = eventStore;
    const observedBatches: number[][] = [];
    const observingStore: EventStore = {
      ...inner,
      appendToStreams: async (inputs) => {
        observedBatches.push(inputs.map((input) => input.events.length));
        return inner.appendToStreams!(inputs);
      },
    };
    eventStore = observingStore;
    services = createServices(observingStore);

    const first = await register();
    expect(first.status).toBe(201);
    const afterFirst = await stateSnapshot();

    const second = await register();
    const third = await register();

    expect(second.status).toBe(201);
    expect(third.status).toBe(201);
    expect(second.body.accountId).toBe(first.body.accountId);
    expect(second.body.userId).toBe(first.body.userId);
    expect(second.body.membershipId).toBe(first.body.membershipId);
    expect(third.body).toMatchObject({
      accountId: first.body.accountId,
      userId: first.body.userId,
      membershipId: first.body.membershipId,
    });
    expect(await stateSnapshot()).toEqual(afterFirst);
    expect(observedBatches).toHaveLength(3);
    expect(observedBatches[0]?.some((eventCount) => eventCount > 0)).toBe(true);
    expect(observedBatches[1]?.every((eventCount) => eventCount === 0)).toBe(true);
    expect(observedBatches[2]?.every((eventCount) => eventCount === 0)).toBe(true);
  });

  it("uses the claim's display name when a recovering request proposes a different one", async () => {
    const first = await register();
    const recovered = await register({ displayName: "A Different Proposal" });

    expect(first.status).toBe(201);
    expect(recovered.status).toBe(201);
    expect(recovered.body.accountId).toBe(first.body.accountId);
    const reservations = await pool.query<{ display_name_key: string }>(
      "SELECT display_name_key FROM identity_account_display_name_reservations",
    );
    expect(reservations.rows).toEqual([{ display_name_key: DISPLAY_NAME_KEY }]);
  });

  it("records the same canonical display name in the claim and Account", async () => {
    const first = await register({ displayName: "  PokeBash   TCG  " });
    const retried = await register();

    expect(first.status).toBe(201);
    expect(retried.status).toBe(201);
    expect(retried.body.accountId).toBe(first.body.accountId);
  });

  it("converges an email-and-phone first call with an email-only retry", async () => {
    const first = await register({ phone: "+1 (555) 555-0123" });
    const retried = await register();

    expect(first.status).toBe(201);
    expect(retried.status).toBe(201);
    expect(retried.body).toMatchObject({
      accountId: first.body.accountId,
      userId: first.body.userId,
      membershipId: first.body.membershipId,
    });
    const userEvents = await eventStore.readStream({ streamId: `identity.user-${String(first.body.userId)}` });
    expect(userEvents.map((event) => event.eventType)).toEqual([
      "identity.user.created",
      "identity.user.contact-method-added",
      "identity.user.contact-method-verified",
      "identity.user.auth-method-enabled",
    ]);
  });

  it("converges phone-only retries across separator styles", async () => {
    const first = await register({ email: null, phone: "+1 (555) 555-0123", displayName: "Phone Owner" });
    const retried = await register({ email: null, phone: "+15555550123", displayName: "Phone Owner" });

    expect(first.status).toBe(201);
    expect(retried.status).toBe(201);
    expect(retried.body.accountId).toBe(first.body.accountId);
    expect(retried.body.userId).toBe(first.body.userId);
  });

  const claimlessShapes = [
    ["account only", { user: false, membership: false, consent: false }],
    ["account and user", { user: true, membership: false, consent: false }],
    ["account, user and membership", { user: true, membership: true, consent: false }],
    ["account, user, membership and partial Consent", { user: true, membership: true, consent: true }],
  ] as const;

  it.each(claimlessShapes)("rejects a claim-less partial with a committed %s", async (_label, shape) => {
    const fixture = createFixtureClaim(operationFor());
    await appendEvents(`identity.account-${fixture.accountId}`, [accountCreated(fixture)]);
    if (shape.user) {
      await appendEvents(`identity.user-${fixture.userId}`, [userCreated(fixture)]);
    }
    if (shape.membership) {
      await appendEvents(`identity.membership-${fixture.membershipId}`, [membershipGranted(fixture)]);
    }
    if (shape.consent) {
      await appendEvents(`identity.consent-${fixture.consentId}`, [consentRecorded(fixture)]);
    }
    await pool.query(
      `INSERT INTO identity_account_display_name_reservations (
           display_name_key, account_id, display_name, operation_key, created_at
         ) VALUES ($1, $2, $3, NULL, now())`,
      [DISPLAY_NAME_KEY, fixture.accountId, DISPLAY_NAME],
    );
    const before = await stateSnapshot();
    expect(before.events.some((event) => event.streamId === fixture.operation.streamId)).toBe(false);
    const membershipCountBefore = before.events.filter((event) =>
      event.streamId.startsWith("identity.membership-"),
    ).length;

    const rejected = await register({}, [TERMS_V1, PRIVACY_V3]);

    expect(rejected.status).toBe(409);
    expect((rejected.body.error as { code?: string } | undefined)?.code).toBe("display_name_already_taken");
    const after = await stateSnapshot();
    expect(after).toEqual(before);
    expect(after.events.filter((event) => event.streamId.startsWith("identity.membership-"))).toHaveLength(
      membershipCountBefore,
    );
    expect(after.events.some((event) => event.streamId.startsWith("identity.registration-operation-"))).toBe(false);
  });
});
