import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import type { IdentityApiEnv } from "../../../api";
import { composeModuleSchemaSql, drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
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
import { EVENT_STORE_READ_PAGE_SIZE_MAX, ZERO_GLOBAL_POSITION, type StoredEvent } from "@chase-sets/event-core/storage";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  CONSENT_ACTIVATION_AUTHORITY_STREAM_PREFIX,
  ConsentActivationAuthorityError,
  consentActivationAuthorityStreamId,
  decodeConsentActivationAuthoritySnapshot,
  readConsentActivationAuthority,
} from "@chase-sets/platform-policy/consent-activation-authority";
import { activeSnapshot } from "../../../tests/consent-activation-authority-fixtures";
import * as bundle from "../domain/consent-bundle";
import type { AccountId, ConsentId, UserId } from "@chase-sets/primitives/typed-ids";
import { module as identityModule } from "../../../index";
import { createIdentityServices } from "../../../support/runtime-support/services";
import { DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY } from "../../account-capabilities/api/authority";
import {
  authorizeConsentForActor,
  type ConsentRecordingAuthorization,
} from "../domain/consent-recording-authorization";
import { createConsentRuntime, type ConsentServices, type RecordTermsConsentInput } from "./runtime";
import { termsOfServiceConsentRoutes } from "./terms-route";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for Identity Consent database tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["identity"] as const;
const authorizedContext = actorContext("usr_authorized", "acc_authorized");
const authorityKey = "identity.terms-of-service-active-version";
const authorityStreamId = consentActivationAuthorityStreamId(authorityKey);

let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
let eventStore: EventStore;
let runtime: ConsentServices;
const publication = {
  ...bundle.identityConsentPolicyPublications["terms-of-service"],
  consentActivatable: true,
  version: "v1" as const,
};
const authority = {
  read: vi.fn(async (key: string) => readConsentActivationAuthority(eventStore, key)),
} satisfies bundle.ConsentActivationAuthorityReader;
let readStream: ReturnType<typeof vi.fn<EventStore["readStream"]>>;
let appendToStreams: ReturnType<typeof vi.fn<NonNullable<EventStore["appendToStreams"]>>>;

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
): RecordTermsConsentInput {
  return {
    streamId: `identity.consent-${consentId}`,
    consentId: consentId as ConsentId,
    subjectType: subject.subjectType as "user",
    userId: subject.userId as UserId,
    accountId: subject.accountId as AccountId,
    recordedAt: "2026-07-28T00:00:00.000Z",
    activationAuthority: authority,
    context: authorizedContext,
    authorization,
  };
}

async function assertRejectedWithoutWrites(consentId: string, input: ReturnType<typeof recordInput>, code: string) {
  const authorityBefore = await eventStore.readStream({ streamId: authorityStreamId });

  await expect(runtime.recordTermsConsent(input)).rejects.toMatchObject({
    name: "ConsentRecordingAuthorizationError",
    code,
  });
  expect(authority.read).not.toHaveBeenCalled();
  expect(readStream).not.toHaveBeenCalled();
  expect(appendToStreams).not.toHaveBeenCalled();

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

async function readCompleteEventHistory(store: EventStore): Promise<readonly StoredEvent[]> {
  const events: StoredEvent[] = [];
  let afterGlobalPosition: StoredEvent["globalPosition"] | undefined;
  while (true) {
    const page = await store.readAll({
      limit: EVENT_STORE_READ_PAGE_SIZE_MAX,
      ...(afterGlobalPosition ? { afterGlobalPosition } : {}),
    });
    events.push(...page);
    if (page.length < EVENT_STORE_READ_PAGE_SIZE_MAX) return events;
    const lastEvent = page.at(-1);
    if (!lastEvent) throw new Error("A full event-store page must have a final event.");
    afterGlobalPosition = lastEvent.globalPosition;
  }
}

type MalformedAuthorityKind = "lifecycle" | "stream" | "revision" | "history";

function malformedAuthorityReader(kind: MalformedAuthorityKind): bundle.ConsentActivationAuthorityReader {
  return {
    read: async (policyKey) => {
      const snapshot = await readConsentActivationAuthority(eventStore, policyKey);
      if (kind === "history") {
        throw new ConsentActivationAuthorityError("history_too_long", "synthetic authority history exceeded its bound");
      }
      const mutated =
        kind === "lifecycle"
          ? { ...snapshot, status: "inactive" }
          : kind === "stream"
            ? { ...snapshot, streamId: `${snapshot.streamId}-forged` }
            : { ...snapshot, authorityVersion: -1 };
      return decodeConsentActivationAuthoritySnapshot(policyKey, mutated as never);
    },
  };
}

function mountedTermsApp(consentActivationAuthority: bundle.ConsentActivationAuthorityReader = authority) {
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      sessionId: "ses_fixture",
      tenantId: "tnt_identity",
      userId: "usr_authorized",
      accountId: "acc_authorized",
      membershipId: "mbr_fixture",
      roleKey: "owner",
      permissions: [],
    });
    c.set("context", authorizedContext);
    await next();
  });
  const recordTermsConsent = vi.fn<ConsentServices["recordTermsConsent"]>(async (input) => {
    const result = await runtime.recordTermsConsent(input);
    await projectStoredEvents(result.storedEvents);
    return result;
  });
  app.route(
    "/terms",
    termsOfServiceConsentRoutes({
      db: pools.identity,
      policies: { consentActivation: consentActivationAuthority },
      consents: { recordTermsConsent },
      publication,
    }),
  );
  app.onError(errorHandler);
  return { app, recordTermsConsent };
}

async function moveAuthority() {
  const snapshot = await readConsentActivationAuthority(eventStore, authorityKey);
  await eventStore.appendToStream({
    streamId: authorityStreamId,
    expectedVersion: snapshot.authorityVersion,
    context: authorizedContext,
    events: [
      {
        eventType: "platform-policy.consent-activation-authority.replaced",
        payload: {
          policyKey: authorityKey,
          previousVersion: "v1",
          activation: {
            version: "v1",
            documentId: `pol_fixture_${snapshot.authorityVersion}`,
            activatedAt: "2026-07-28T01:00:00.000Z",
            actorUserId: "usr_authorized",
          },
        },
      },
    ],
  });
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
    await pools.identity.query(composeModuleSchemaSql(identityModule));
    eventStore = createPostgresEventStore({ pool: pools.identity });
    readStream = vi.fn(eventStore.readStream);
    appendToStreams = vi.fn(eventStore.appendToStreams!);
    authority.read.mockClear();
    vi.spyOn(bundle, "resolveConsentPolicyMemberWithProvenance").mockImplementation((reader, policyKey) =>
      bundle.resolveConsentPolicyMemberWithProvenanceAgainstPublication(reader, policyKey, publication),
    );
    runtime = createConsentRuntime({
      eventStore: { ...eventStore, readStream, appendToStreams },
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
          payload: {
            policyKey: authorityKey,
            registration: {
              contextName: "identity",
              schemaSummary: "active consent version",
              registeredAt: "2026-07-28T00:00:00.000Z",
            },
          },
        },
        {
          eventType: "platform-policy.consent-activation-authority.activated",
          payload: {
            policyKey: authorityKey,
            activation: {
              version: "v1",
              documentId: "pol_terms_fixture",
              activatedAt: "2026-07-28T00:00:00.000Z",
              actorUserId: "usr_authorized",
            },
          },
        },
      ],
    });
    await expect(readConsentActivationAuthority(eventStore, authorityKey)).resolves.toMatchObject({
      streamId: authorityStreamId,
      isActive: true,
      activeVersion: "v1",
      authorityVersion: 2,
    });
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["forged", "unrelated", "version-mismatch", "unresolved", "forged-guard"] as const)(
    "rejects %s member at the real runtime boundary without Consent I/O",
    async (kind) => {
      const policyKey = kind === "unrelated" ? "privacy-policy" : "terms-of-service";
      const snapshot = await readConsentActivationAuthority(eventStore, authorityKey);
      const key = `identity.${policyKey}-active-version`;
      const reader: bundle.ConsentActivationAuthorityReader = {
        read: async () => {
          if (kind === "unresolved")
            throw new ConsentActivationAuthorityError("snapshot_guard_mismatch", "synthetic unreadable authority");
          if (kind === "unrelated") return activeSnapshot(key, "v1");
          return kind === "forged-guard" ? ({ ...snapshot, guard: { ...snapshot.guard } } as never) : snapshot;
        },
      };
      const member = await bundle.resolveConsentPolicyMemberWithProvenanceAgainstPublication(reader, policyKey, {
        ...bundle.identityConsentPolicyPublications[policyKey],
        consentActivatable: true,
        version: kind === "version-mismatch" ? "v2" : "v1",
      });
      vi.mocked(bundle.resolveConsentPolicyMemberWithProvenance).mockResolvedValueOnce(
        kind === "forged" ? { ...member } : member,
      );
      const consentId = `cns_db_${kind.replaceAll("-", "_")}`;
      const before = await eventStore.readStream({ streamId: authorityStreamId });
      await expect(
        runtime.recordTermsConsent(
          recordInput(consentId, authorizeConsentForActor(authorizedContext), {
            subjectType: "user",
            userId: "usr_authorized",
            accountId: "acc_authorized",
          }),
        ),
      ).rejects.toMatchObject(
        kind === "forged-guard" ? { code: "unvalidated_activation_guard" } : { name: "IdentityDomainError" },
      );
      expect(readStream).not.toHaveBeenCalled();
      expect(appendToStreams).not.toHaveBeenCalled();
      await expect(eventStore.readStream({ streamId: `identity.consent-${consentId}` })).resolves.toEqual([]);
      await expect(eventStore.readStream({ streamId: authorityStreamId })).resolves.toEqual(before);
    },
  );

  it.each(["lifecycle", "stream", "revision", "history"] as const)(
    "fails closed on %s authority corruption at the Terms route",
    async (kind) => {
      const before = await eventStore.readStream({ streamId: authorityStreamId });
      const beforeEvents = await readCompleteEventHistory(eventStore);
      const response = await mountedTermsApp(malformedAuthorityReader(kind)).app.request("/terms/accept", {
        method: "POST",
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "terms_of_service_not_active",
          message: "No Terms of Service version is currently active for acceptance.",
        },
      });
      expect(appendToStreams).not.toHaveBeenCalled();
      await expect(eventStore.readStream({ streamId: authorityStreamId })).resolves.toEqual(before);
      const afterEvents = await readCompleteEventHistory(eventStore);
      expect(afterEvents.filter((event) => event.streamId.startsWith("identity.consent-"))).toEqual(
        beforeEvents.filter((event) => event.streamId.startsWith("identity.consent-")),
      );
    },
  );

  it("publication-ineligible runtime admission observes zero authority reads, store reads and appends", async () => {
    vi.mocked(bundle.resolveConsentPolicyMemberWithProvenance).mockRestore();
    await expect(
      runtime.recordTermsConsent(
        recordInput("cns_db_ineligible", authorizeConsentForActor(authorizedContext), {
          subjectType: "user",
          userId: "usr_authorized",
          accountId: "acc_authorized",
        }),
      ),
    ).rejects.toThrow(/active/i);
    expect(authority.read).not.toHaveBeenCalled();
    expect(readStream).not.toHaveBeenCalled();
    expect(appendToStreams).not.toHaveBeenCalled();
    await expect(eventStore.readStream({ streamId: "identity.consent-cns_db_ineligible" })).resolves.toEqual([]);
  });

  it("authority movement between resolution and append cannot commit stale Consent", async () => {
    appendToStreams.mockImplementationOnce(async (inputs) => {
      await moveAuthority();
      return eventStore.appendToStreams!(inputs);
    });
    const input = recordInput("cns_db_stale", authorizeConsentForActor(authorizedContext), {
      subjectType: "user",
      userId: "usr_authorized",
      accountId: "acc_authorized",
    });
    await expect(runtime.recordTermsConsent(input)).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect(appendToStreams).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ streamId: input.streamId, events: [expect.any(Object)] }),
      expect.objectContaining({ streamId: authorityStreamId, expectedVersion: 2, events: [] }),
    ]);
    await expect(eventStore.readStream({ streamId: input.streamId })).resolves.toEqual([]);
    await expect(eventStore.readStream({ streamId: authorityStreamId })).resolves.toHaveLength(3);
  });

  it("unmoved Terms acceptance returns 201, then already-current returns 200 without append", async () => {
    const { app, recordTermsConsent } = mountedTermsApp();
    const first = await app.request("/terms/accept", { method: "POST" });
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({ accepted: true, requiredVersion: "v1" });
    const second = await app.request("/terms/accept", { method: "POST" });
    expect(second.status).toBe(200);
    expect(recordTermsConsent).toHaveBeenCalledTimes(1);
    expect(appendToStreams).toHaveBeenCalledTimes(1);
    await expect(eventStore.readStream({ streamId: authorityStreamId })).resolves.toHaveLength(2);
    expect(
      (await readCompleteEventHistory(eventStore)).filter((event) => event.eventType === "identity.consent.recorded"),
    ).toHaveLength(1);
  });

  it("withdraws an internally recorded Terms Consent through the preserved handler", async () => {
    const input = recordInput("cns_db_withdraw", authorizeConsentForActor(authorizedContext), {
      subjectType: "user",
      userId: "usr_authorized",
      accountId: "acc_authorized",
    });
    await runtime.recordTermsConsent(input);
    const result = await runtime.commandHandler({
      streamId: input.streamId,
      context: authorizedContext,
      authorization: input.authorization,
      command: { type: "WithdrawConsent", withdrawnAt: "2026-07-28T01:00:00.000Z" },
    });
    expect(result.state.status).toBe("withdrawn");
    await expect(eventStore.readStream({ streamId: input.streamId })).resolves.toHaveLength(2);
    await expect(eventStore.readStream({ streamId: authorityStreamId })).resolves.toHaveLength(2);
  });

  it.each([false, true])(
    "route re-resolves guards after PostgreSQL conflict with exactly two attempts (exhaust=%s)",
    async (exhaust) => {
      let attempts = 0;
      appendToStreams.mockImplementation(async (inputs) => {
        attempts += 1;
        if (attempts === 1 || exhaust) await moveAuthority();
        return eventStore.appendToStreams!(inputs);
      });
      const { app, recordTermsConsent } = mountedTermsApp();
      const response = await app.request("/terms/accept", { method: "POST" });
      expect(response.status).toBe(exhaust ? 409 : 201);
      if (exhaust) await expect(response.json()).resolves.toMatchObject({ error: { code: "conflict" } });
      expect(recordTermsConsent).toHaveBeenCalledTimes(2);
      expect(
        appendToStreams.mock.calls.map(
          ([inputs]) => inputs.find((input) => input.streamId === authorityStreamId)?.expectedVersion,
        ),
      ).toEqual([2, 3]);
      expect(
        appendToStreams.mock.calls.map(
          ([inputs]) => inputs.find((input) => input.streamId === authorityStreamId)?.events,
        ),
      ).toEqual([[], []]);
      const events = (await readCompleteEventHistory(eventStore)).filter(
        (event) => event.eventType === "identity.consent.recorded",
      );
      expect(events).toHaveLength(exhaust ? 0 : 1);
      expect(JSON.stringify(appendToStreams.mock.calls)).not.toContain("authorization-only");
    },
  );

  it.each([
    { policyKey: "seller-agreement", policyVersion: "v999" },
    { policyKey: "privacy-policy", policyVersion: "future-v999", guards: [] },
  ])("closes the #6815 $policyKey generic recording probe before PostgreSQL I/O", async (probe) => {
    await expect(
      runtime.commandHandler({
        streamId: "identity.consent-cns_probe",
        context: authorizedContext,
        authorization: authorizeConsentForActor(authorizedContext),
        command: {
          type: "RecordConsent",
          consentId: "cns_probe",
          subjectType: "user",
          userId: "usr_authorized",
          accountId: "acc_authorized",
          recordedAt: "2026-07-28T00:00:00.000Z",
          ...probe,
        },
      } as never),
    ).rejects.toThrow(/withdraw/i);
    expect(readStream).not.toHaveBeenCalled();
    expect(appendToStreams).not.toHaveBeenCalled();
    await expect(eventStore.readStream({ streamId: "identity.consent-cns_probe" })).resolves.toEqual([]);
  });

  it("rejects a foreign user with a named code, zero Consent events, unchanged authority, and no projection row", async () => {
    const consentId = "cns_db_foreign_user";
    await assertRejectedWithoutWrites(
      consentId,
      recordInput(consentId, authorizeConsentForActor(authorizedContext), {
        subjectType: "user",
        userId: "usr_foreign",
        accountId: "acc_authorized",
      }),
      "consent_user_not_authorized",
    );
  });

  it("rejects an invalid Terms subject with zero reads, zero Consent events, unchanged authority, and no projection row", async () => {
    const consentId = "cns_db_foreign_account";
    await assertRejectedWithoutWrites(
      consentId,
      recordInput(consentId, authorizeConsentForActor(authorizedContext), {
        subjectType: "account",
        userId: "usr_authorized",
        accountId: "acc_authorized",
      }),
      "consent_subject_invalid",
    );
  });

  it("rejects a mismatched context before authority and store reads", async () => {
    const consentId = "cns_db_foreign_acting_user";
    await assertRejectedWithoutWrites(
      consentId,
      {
        ...recordInput(consentId, authorizeConsentForActor(authorizedContext), {
          subjectType: "user",
          userId: "usr_authorized",
          accountId: "acc_authorized",
        }),
        context: actorContext("usr_foreign", "acc_authorized"),
      },
      "consent_authorization_context_mismatch",
    );
  });

  it.each([{ subjectType: "user" as const, consentId: "cns_db_exact_user" }])(
    "records and projects the exact authorized $subjectType identity",
    async ({ subjectType, consentId }) => {
      const result = await runtime.recordTermsConsent(
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
    },
  );

  it.each([
    { profile: "scenario-seed", accounts: 8, users: 8, memberships: 8, readsProjections: false },
    { profile: "representative-commerce-state", accounts: 5, users: 5, memberships: 5, readsProjections: false },
    // Admin-QA runs beside the host's projection runner, so its reruns also see
    // drained projections. The viewer's secondary Account and Membership add
    // one of each (#7363).
    { profile: "admin-qa-actor-fixtures", accounts: 7, users: 6, memberships: 7, readsProjections: true },
  ] as const)(
    "provisions $profile identities with no Consent fact and no activation-authority read",
    async ({ profile, accounts, users, memberships, readsProjections }) => {
      const seed = identityModule.seed;
      if (!seed) {
        throw new Error("Identity module must expose its seed boundary.");
      }
      const drainProjections = async () => {
        if (!readsProjections) return;
        await drainLocalProjectionHandlerSets(
          "identity",
          pools.identity,
          createIdentityServices(pools.identity, {
            capabilityAdministrationAuthority: DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY,
          }).projectors,
        );
      };
      const authorityBefore = await eventStore.readStream({ streamId: authorityStreamId });
      const boot = observeStatementValues(pools.identity);

      // Clean boot, then a repeat inside the same boot.
      await seed(boot.pool, undefined, { enabledDataProfiles: [profile] });
      await drainProjections();
      const provisioned = await identityProvisioningState();
      expect(provisioned.created).toEqual({
        "identity.account.created": accounts,
        "identity.user.created": users,
        "identity.membership.granted": memberships,
        "identity.consent.recorded": 0,
      });
      await seed(boot.pool, undefined, { enabledDataProfiles: [profile] });
      await drainProjections();
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
    await observedRuntime.recordTermsConsent(
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
