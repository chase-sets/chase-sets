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

  it.each(["scenario-seed", "representative-commerce-state", "admin-qa-actor-fixtures"] as const)(
    "admits every %s Consent through the named provisioning authorization",
    async (profile) => {
      if (!identityModule.seed) {
        throw new Error("Identity module must expose its seed boundary.");
      }
      await identityModule.seed(pools.identity, undefined, { enabledDataProfiles: [profile] });

      const recorded = await pools.identity.query<{
        payload: {
          subjectType: string;
          userId: string | null;
          accountId: string | null;
        };
        performed_by_user_id: string;
        for_account_id: string;
      }>(
        `SELECT payload, performed_by_user_id, for_account_id
         FROM event_store_events
        WHERE event_type = 'identity.consent.recorded'
        ORDER BY global_position`,
      );

      expect(recorded.rows.length).toBeGreaterThan(0);
      for (const row of recorded.rows) {
        expect(row.performed_by_user_id).toBe("usr_identity_system");
        expect(row.for_account_id).toBe("acc_identity_system");
        expect(row.payload.subjectType).toBe("user");
        expect(row.payload.userId).toMatch(/^usr_\S+$/);
        expect(row.payload.accountId).toMatch(/^acc_\S+$/);
        expect(row.payload.userId).not.toBe("usr_identity_system");
        expect(row.payload.userId).not.toBe("usr_guest_checkout");
        expect(row.payload.accountId).not.toBe("acc_identity_system");
      }
    },
  );
});
