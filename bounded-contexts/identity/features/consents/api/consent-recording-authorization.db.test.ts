import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { CONSENT_ACTIVATION_AUTHORITY_STREAM_PREFIX } from "@chase-sets/platform-policy/consent-activation-authority";
import type { AccountId, ConsentId, UserId } from "@chase-sets/primitives/typed-ids";
import { module as identityModule } from "../../../index";
import {
  authorizeConsentForActor,
  type ConsentRecordingAuthorization,
} from "../domain/consent-recording-authorization";
import { createConsentRuntime, type ConsentServices } from "./runtime";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for Identity Consent database tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["identity"] as const;
const authorizedContext = actorContext("usr_authorized", "acc_authorized");
const authorityStreamId = "platform-policy.consent-activation-authority-identity.terms-of-service";

let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
let eventStore: EventStore;
let runtime: ConsentServices;

function actorContext(userId: string, accountId: string): EventStoreContext {
  return {
    tenantId: "tnt_identity" as never,
    audit: {
      performedByUserId: userId as UserId,
      forAccountId: accountId as AccountId,
    },
    trace: {},
  };
}

function recordInput(
  consentId: string,
  authorization: ConsentRecordingAuthorization,
  subject: Readonly<{
    subjectType: "account" | "user";
    userId: string;
    accountId: string;
  }>,
) {
  return {
    streamId: `identity.consent-${consentId}`,
    command: {
      type: "RecordConsent" as const,
      consentId: consentId as ConsentId,
      subjectType: subject.subjectType,
      userId: subject.userId as UserId,
      accountId: subject.accountId as AccountId,
      policyKey: "terms-of-service",
      policyVersion: "v1",
      recordedAt: "2026-07-28T00:00:00.000Z",
    },
    context: authorizedContext,
    authorization,
  };
}

async function assertRejectedWithoutWrites(consentId: string, input: ReturnType<typeof recordInput>, code: string) {
  const authorityBefore = await eventStore.readStream({ streamId: authorityStreamId });

  await expect(runtime.commandHandler(input)).rejects.toMatchObject({
    name: "ConsentRecordingAuthorizationError",
    code,
  });

  await expect(eventStore.readStream({ streamId: `identity.consent-${consentId}` })).resolves.toHaveLength(0);
  await expect(eventStore.readStream({ streamId: authorityStreamId })).resolves.toEqual(authorityBefore);
  const projection = await pools.identity.query("SELECT consent_id FROM identity_consents WHERE consent_id = $1", [
    consentId,
  ]);
  expect(projection.rows).toHaveLength(0);
}

/**
 * Wraps a pool so every string statement parameter is recorded. Stream reads
 * and appends carry their stream id as a parameter, so this observes whether a
 * workflow touched a Consent stream or read the activation authority.
 */
function observeStatementValues(pool: PgTransactionalPool) {
  const values: string[] = [];
  const record = (params: readonly unknown[] | undefined) => {
    for (const param of (params ?? []).flat()) {
      if (typeof param === "string") values.push(param);
    }
  };
  const observedQuery = (query: PgTransactionalPool["query"]) =>
    ((text: string, params?: readonly unknown[]) => {
      record(params);
      return query(text, params);
    }) as PgTransactionalPool["query"];
  const observed: PgTransactionalPool = {
    query: observedQuery(pool.query.bind(pool)),
    connect: async () => {
      const client = await pool.connect();
      return { query: observedQuery(client.query.bind(client)), release: (error) => client.release(error) };
    },
    idleInTransactionSessionTimeoutMillis: pool.idleInTransactionSessionTimeoutMillis,
  };
  return { pool: observed, values };
}

async function identityProvisioningState() {
  const createdEventTypes = [
    "identity.account.created",
    "identity.user.created",
    "identity.membership.granted",
    "identity.consent.recorded",
  ] as const;
  const result = await pools.identity.query<{ event_type: string; count: string }>(
    `SELECT event_type, COUNT(*) AS count
       FROM event_store_events
      WHERE stream_id LIKE 'identity.%'
      GROUP BY event_type`,
  );
  const counts = new Map(result.rows.map((row) => [row.event_type, Number(row.count)]));
  return {
    created: Object.fromEntries(createdEventTypes.map((eventType) => [eventType, counts.get(eventType) ?? 0])),
    totalEvents: [...counts.values()].reduce((total, count) => total + count, 0),
  };
}

async function projectStoredEvents(
  storedEvents: Awaited<ReturnType<ConsentServices["commandHandler"]>>["storedEvents"],
) {
  for (const storedEvent of storedEvents) {
    const event = toTransportEvent(storedEvent);
    for (const projector of runtime.projectors) {
      await projector.handlers[storedEvent.eventType]?.(event);
    }
  }
}

describeDb("Consent Recording Authorization against real PostgreSQL", () => {
  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "identity_consent_authorization",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.identity.query(identityModule.schemaSql);
    eventStore = createPostgresEventStore({ pool: pools.identity });
    runtime = createConsentRuntime({
      eventStore,
      checkpointStore: {
        loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
        saveCheckpoint: async () => undefined,
      },
      db: pools.identity,
    });
    await eventStore.appendToStream({
      streamId: authorityStreamId,
      expectedVersion: "no_stream",
      context: authorizedContext,
      events: [
        {
          eventType: "platform-policy.consent-activation-authority.registered",
          payload: { policyKey: "identity.terms-of-service-active-version" },
        },
      ],
    });
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("rejects a foreign user with a named code, zero Consent events, unchanged authority, and no projection row", async () => {
    const consentId = "cns_db_foreign_user";
    await assertRejectedWithoutWrites(
      consentId,
      recordInput(consentId, authorizeConsentForActor(authorizedContext), {
        subjectType: "user",
        userId: "usr_foreign",
        accountId: "acc_victim",
      }),
      "consent_user_not_authorized",
    );
  });

  it("rejects a foreign account with a named code, zero Consent events, unchanged authority, and no projection row", async () => {
    const consentId = "cns_db_foreign_account";
    await assertRejectedWithoutWrites(
      consentId,
      recordInput(consentId, authorizeConsentForActor(authorizedContext), {
        subjectType: "account",
        userId: "usr_authorized",
        accountId: "acc_foreign",
      }),
      "consent_account_not_authorized",
    );
  });

  it("rejects a foreign acting user with a named code, zero Consent events, unchanged authority, and no projection row", async () => {
    const consentId = "cns_db_foreign_acting_user";
    await assertRejectedWithoutWrites(
      consentId,
      recordInput(consentId, authorizeConsentForActor(authorizedContext), {
        subjectType: "account",
        userId: "usr_foreign",
        accountId: "acc_authorized",
      }),
      "consent_acting_user_not_authorized",
    );
  });

  it.each([
    { subjectType: "user" as const, consentId: "cns_db_exact_user" },
    { subjectType: "account" as const, consentId: "cns_db_exact_account" },
  ])("records and projects the exact authorized $subjectType identity", async ({ subjectType, consentId }) => {
    const result = await runtime.commandHandler(
      recordInput(consentId, authorizeConsentForActor(authorizedContext), {
        subjectType,
        userId: "usr_authorized",
        accountId: "acc_authorized",
      }),
    );
    expect(result.storedEvents).toEqual([
      expect.objectContaining({
        performedByUserId: "usr_authorized",
        forAccountId: "acc_authorized",
      }),
    ]);
    await projectStoredEvents(result.storedEvents);

    await expect(eventStore.readStream({ streamId: `identity.consent-${consentId}` })).resolves.toHaveLength(1);
    const projection = await pools.identity.query<{
      subject_type: string;
      user_id: string;
      account_id: string;
      status: string;
    }>(
      `SELECT subject_type, user_id, account_id, status
         FROM identity_consents
        WHERE consent_id = $1`,
      [consentId],
    );
    expect(projection.rows).toEqual([
      {
        subject_type: subjectType,
        user_id: "usr_authorized",
        account_id: "acc_authorized",
        status: "recorded",
      },
    ]);
  });

  it.each([
    { profile: "scenario-seed", created: 8 },
    { profile: "representative-commerce-state", created: 5 },
    { profile: "admin-qa-actor-fixtures", created: 6 },
  ] as const)(
    "provisions $profile identities with no Consent fact and no activation-authority read",
    async ({ profile, created }) => {
      const seed = identityModule.seed;
      if (!seed) {
        throw new Error("Identity module must expose its seed boundary.");
      }
      const authorityBefore = await eventStore.readStream({ streamId: authorityStreamId });
      const boot = observeStatementValues(pools.identity);

      // Clean boot, then a repeat inside the same boot.
      await seed(boot.pool, undefined, { enabledDataProfiles: [profile] });
      const provisioned = await identityProvisioningState();
      expect(provisioned.created).toEqual({
        "identity.account.created": created,
        "identity.user.created": created,
        "identity.membership.granted": created,
        "identity.consent.recorded": 0,
      });
      await seed(boot.pool, undefined, { enabledDataProfiles: [profile] });
      await expect(identityProvisioningState()).resolves.toEqual(provisioned);

      // A fresh boot over the retained state authors nothing.
      const rerun = observeStatementValues(pools.identity);
      await seed(rerun.pool, undefined, { enabledDataProfiles: [profile] });
      await expect(identityProvisioningState()).resolves.toEqual(provisioned);

      // Neither boot touched a Consent stream or read the activation authority.
      for (const values of [boot.values, rerun.values]) {
        expect(values.filter((value) => value.startsWith("identity.consent-"))).toEqual([]);
        expect(values.filter((value) => value.startsWith(CONSENT_ACTIVATION_AUTHORITY_STREAM_PREFIX))).toEqual([]);
      }
      await expect(eventStore.readStream({ streamId: authorityStreamId })).resolves.toEqual(authorityBefore);
      const projected = await pools.identity.query("SELECT consent_id FROM identity_consents");
      expect(projected.rows).toEqual([]);
    },
  );

  it("observes a Consent write and an activation-authority read through the statement recorder", async () => {
    const observed = observeStatementValues(pools.identity);
    const observedRuntime = createConsentRuntime({
      eventStore: createPostgresEventStore({ pool: observed.pool }),
      checkpointStore: {
        loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
        saveCheckpoint: async () => undefined,
      },
      db: observed.pool,
    });
    const consentId = "cns_db_observed_write";
    await observedRuntime.commandHandler(
      recordInput(consentId, authorizeConsentForActor(authorizedContext), {
        subjectType: "user",
        userId: "usr_authorized",
        accountId: "acc_authorized",
      }),
    );
    await createPostgresEventStore({ pool: observed.pool }).readStream({ streamId: authorityStreamId });

    // Negative control: the recorder the provisioning case relies on does see
    // both a restored Consent write and a forced activation-authority read.
    expect(observed.values).toContain(`identity.consent-${consentId}`);
    expect(observed.values).toContain(authorityStreamId);
  });
});
