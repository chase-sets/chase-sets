import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres/event-store";
import {
  createIsolatedPostgresTestSchema,
  type IsolatedPostgresTestSchema,
} from "@chase-sets/event-core-postgres/postgres-db-test-support";
import { createPolicyCache, type PolicyCache, type PolicyDocumentCandidate } from "./cache";
import { consentActivationAuthorityStreamId } from "./consent-activation-authority";
import { definePolicy, type PolicyDefinition } from "./define-policy";
import { createPolicyRuntime, type PolicyRuntime } from "./runtime";
import { platformPolicySchemaSql } from "./schema";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_admin" as never,
    forAccountId: "acc_admin" as never,
  },
} satisfies EventStoreContext;

type ConsentValue = Readonly<{ version: string }>;

const consentPolicy: PolicyDefinition<ConsentValue> = definePolicy<ConsentValue>({
  policyKey: "identity.terms-of-service-active-version",
  contextName: "identity",
  schemaSummary: "{ version: string }",
  defaultValue: { version: "v0" },
  decodeValue: (raw) => ({ version: (raw as { version: string }).version }),
});

const nonConsentPolicy: PolicyDefinition<ConsentValue> = definePolicy<ConsentValue>({
  policyKey: "pricing.market-estimate-parameters",
  contextName: "pricing",
  schemaSummary: "{ version: string }",
  defaultValue: { version: "v0" },
  decodeValue: (raw) => ({ version: (raw as { version: string }).version }),
});

/**
 * The six streams a registration commits across. The guarded probe below
 * asserts every one of them is empty after a rejected append, which is the
 * shape of the original finding: six registration events committed with zero
 * Consents beside them.
 */
const REGISTRATION_STREAM_IDS = [
  "identity.account-acc_probe",
  "identity.user-usr_probe",
  "identity.membership-mbr_probe",
  "identity.consent-cns_probe",
  "identity.user-email-eml_probe",
  "identity.account-profile-acp_probe",
] as const;

function registrationAppends(): AppendToStreamInput[] {
  return REGISTRATION_STREAM_IDS.map((streamId) => ({
    streamId,
    expectedVersion: "no_stream" as const,
    context,
    events: [{ eventType: `${streamId.split("-")[0]}.recorded`, payload: { streamId } }],
  }));
}

describeDb("consent activation authority against a real event store", () => {
  let schema: IsolatedPostgresTestSchema;
  let eventStore: EventStore;
  let cache: PolicyCache;
  let runtime: PolicyRuntime;

  beforeEach(async () => {
    schema ??= await createIsolatedPostgresTestSchema(adminDatabaseUrl!, "consent_authority");
    await schema.reset();
    await schema.pool.query(platformPolicySchemaSql);
    await schema.pool.query("TRUNCATE TABLE platform_policy_documents, platform_policy_document_history");
    eventStore = createPostgresEventStore({ pool: schema.pool });
    cache = createPolicyCache();
    runtime = createPolicyRuntime({ eventStore, db: schema.pool, cache });
  });

  afterAll(async () => {
    await schema?.close();
  });

  async function streamEvents(streamId: string): Promise<readonly StoredEvent[]> {
    return eventStore.readStream({ streamId });
  }

  async function registerAndActivate(version: string, documentId: string) {
    await runtime.consentActivation.register(consentPolicy, context);
    await runtime.consentActivation.activate(consentPolicy, { version, documentId, actorUserId: "usr_admin" }, context);
  }

  it("rejects a guarded append when the policy is activated after the authority read", async () => {
    // The read happens while the key has never been activated: the state the
    // document-keyed stream could not express, and therefore could not guard.
    const before = await runtime.consentActivation.read(consentPolicy.policyKey);
    expect(before.status).toBe("never-activated");
    expect(before.guard.expectedVersion).toBe("no_stream");

    // First activation lands between the read and the append.
    await registerAndActivate("v1", "pol_terms");

    const appendToStreams = eventStore.appendToStreams!;
    const rejection = await appendToStreams([
      runtime.consentActivation.guardAppendInput(before.guard, context),
      ...registrationAppends(),
    ]).catch((error: unknown) => error);

    expect(rejection).toMatchObject({ code: "concurrency_conflict" });

    // Nothing was written to ANY stream in the transaction.
    for (const streamId of REGISTRATION_STREAM_IDS) {
      expect(await streamEvents(streamId)).toHaveLength(0);
    }

    const after = await runtime.consentActivation.read(consentPolicy.policyKey);
    expect(after.status).toBe("active");
    expect(after.activeVersion).toBe("v1");
    // The rejected append contributed no history to the authority either.
    expect(after.authorityVersion).toBe(2);
  });

  it("commits every stream when the authority has not moved since the read", async () => {
    await registerAndActivate("v1", "pol_terms");
    const snapshot = await runtime.consentActivation.read(consentPolicy.policyKey);

    const appendToStreams = eventStore.appendToStreams!;
    await appendToStreams([
      runtime.consentActivation.guardAppendInput(snapshot.guard, context),
      ...registrationAppends(),
    ]);

    for (const streamId of REGISTRATION_STREAM_IDS) {
      expect(await streamEvents(streamId)).toHaveLength(1);
    }
    expect(await streamEvents(snapshot.streamId)).toHaveLength(snapshot.authorityVersion);
  });

  it("rejects a guarded append when a replacement lands after the authority read", async () => {
    await registerAndActivate("v1", "pol_terms");
    const before = await runtime.consentActivation.read(consentPolicy.policyKey);

    await runtime.consentActivation.activate(
      consentPolicy,
      { version: "v2", documentId: "pol_terms_v2", actorUserId: "usr_admin" },
      context,
    );

    const appendToStreams = eventStore.appendToStreams!;
    await expect(
      appendToStreams([runtime.consentActivation.guardAppendInput(before.guard, context), ...registrationAppends()]),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });

    for (const streamId of REGISTRATION_STREAM_IDS) {
      expect(await streamEvents(streamId)).toHaveLength(0);
    }
  });

  it("never pairs a cached policy value with an independently read authority revision", async () => {
    await registerAndActivate("v1", "pol_terms");

    // The exact disagreement shape: a warm cache holding v1 while the
    // authority stream has already moved to v2.
    const staleCandidate: PolicyDocumentCandidate = {
      documentId: "pol_terms",
      value: { version: "v1" },
      effectiveFrom: "2026-07-01T00:00:00.000Z",
      effectiveUntil: null,
    };
    cache.set(consentPolicy.policyKey, [staleCandidate]);

    await runtime.consentActivation.activate(
      consentPolicy,
      { version: "v2", documentId: "pol_terms_v2", actorUserId: "usr_admin" },
      context,
    );

    const resolved = await runtime.resolvePolicy(consentPolicy);
    const snapshot = await runtime.consentActivation.read(consentPolicy.policyKey);

    expect(resolved.value.version).toBe("v1");
    expect(snapshot.activeVersion).toBe("v2");
    expect(snapshot.guard.expectedVersion).toBe(snapshot.authorityVersion);
    expect(Object.keys(resolved)).not.toContain("guard");
    expect(Object.keys(resolved)).not.toContain("expectedVersion");

    // A guard minted from the stale-cache era of this key is already invalid,
    // so the stale value cannot be committed against the newer revision.
    const staleGuard = { policyKey: consentPolicy.policyKey, streamId: snapshot.streamId, expectedVersion: 2 };
    const appendToStreams = eventStore.appendToStreams!;
    await expect(
      appendToStreams([runtime.consentActivation.guardAppendInput(staleGuard, context), ...registrationAppends()]),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });
    for (const streamId of REGISTRATION_STREAM_IDS) {
      expect(await streamEvents(streamId)).toHaveLength(0);
    }
  });

  it("reads inactive when the authority container exists with zero contents", async () => {
    // A guard-only append materializes the authority's stream row without
    // writing a single event to it. Row presence is not activation.
    const before = await runtime.consentActivation.read(consentPolicy.policyKey);
    const appendToStreams = eventStore.appendToStreams!;
    await appendToStreams([
      runtime.consentActivation.guardAppendInput(before.guard, context),
      ...registrationAppends(),
    ]);

    const streamRows = await schema.pool.query<{ current_version: string }>(
      "SELECT current_version FROM event_store_streams WHERE stream_id = $1",
      [consentActivationAuthorityStreamId(consentPolicy.policyKey)],
    );
    expect(streamRows.rows).toHaveLength(1);

    const after = await runtime.consentActivation.read(consentPolicy.policyKey);
    expect(after.status).toBe("never-activated");
    expect(after.isActive).toBe(false);
    expect(after.authorityVersion).toBe(0);
    expect(after.guard.expectedVersion).toBe("no_stream");

    // Work still ran: the guarded transaction committed its own streams.
    for (const streamId of REGISTRATION_STREAM_IDS) {
      expect(await streamEvents(streamId)).toHaveLength(1);
    }
  });

  it("reads inactive when an active policy document exists but the authority was never activated", async () => {
    const created = await runtime.createPolicyDocument(
      consentPolicy,
      {
        status: "active",
        value: { version: "v1" },
        effectiveFrom: "2026-07-01T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: "usr_admin",
      },
      context,
    );
    await schema.pool.query(
      `INSERT INTO platform_policy_documents (
         document_id, policy_key, context_name, schema_summary, status, value,
         effective_from, effective_until, created_at, updated_at
       ) VALUES ($1, $2, 'identity', '{ version: string }', 'active', '{"version":"v1"}'::jsonb,
         '2026-07-01T00:00:00.000Z', NULL, now(), now())`,
      [created.documentId, consentPolicy.policyKey],
    );

    const resolved = await runtime.resolvePolicy(consentPolicy);
    expect(resolved.source).toBe("policy");

    // A document is the value. It is never the activation.
    const snapshot = await runtime.consentActivation.read(consentPolicy.policyKey);
    expect(snapshot.status).toBe("never-activated");
    expect(snapshot.isActive).toBe(false);
    expect(snapshot.registered).toBe(false);
  });

  it("reconciles a registration whose recorded metadata conflicts instead of skipping it", async () => {
    await runtime.consentActivation.register(consentPolicy, context);

    const conflicting = definePolicy<ConsentValue>({
      policyKey: consentPolicy.policyKey,
      contextName: "marketplace",
      schemaSummary: "{ version: string }",
      defaultValue: { version: "v0" },
      decodeValue: (raw) => ({ version: (raw as { version: string }).version }),
    });

    await expect(runtime.consentActivation.register(conflicting, context)).rejects.toMatchObject({
      code: "registration_conflict",
    });

    // Converges instead when the metadata matches.
    const converged = await runtime.consentActivation.register(consentPolicy, context);
    expect(converged.authorityVersion).toBe(1);
  });

  it("keeps authority state correct when the projection is truncated and the streams survive", async () => {
    await registerAndActivate("v1", "pol_terms");
    await schema.pool.query(
      `INSERT INTO platform_policy_documents (
         document_id, policy_key, context_name, schema_summary, status, value,
         effective_from, effective_until, created_at, updated_at
       ) VALUES ('pol_terms', $1, 'identity', '{ version: string }', 'active', '{"version":"v1"}'::jsonb,
         '2026-07-01T00:00:00.000Z', NULL, now(), now())`,
      [consentPolicy.policyKey],
    );

    // The verified crash-recovery shape: unlogged projections are truncated
    // while event_store_events survives.
    await schema.pool.query("TRUNCATE TABLE platform_policy_documents, platform_policy_document_history");
    cache.invalidateAll();

    const resolved = await runtime.resolvePolicy(consentPolicy);
    expect(resolved.source).toBe("fallback");

    const snapshot = await runtime.consentActivation.read(consentPolicy.policyKey);
    expect(snapshot.status).toBe("active");
    expect(snapshot.activeVersion).toBe("v1");
    expect(snapshot.activeDocumentId).toBe("pol_terms");
  });

  it("registering a consent-capable key with no options leaves it inactive", async () => {
    const snapshot = await runtime.consentActivation.register(consentPolicy, context);

    expect(snapshot.registered).toBe(true);
    expect(snapshot.status).toBe("never-activated");
    expect(snapshot.isActive).toBe(false);
    expect(snapshot.activeVersion).toBeNull();
  });

  it("leaves a policy with no consent authority resolving exactly as before", async () => {
    const resolved = await runtime.resolvePolicy(nonConsentPolicy);

    expect(resolved.source).toBe("fallback");
    expect(resolved.documentId).toBeNull();
    expect(resolved.effectiveFrom).toBeNull();
    expect(resolved.effectiveUntil).toBeNull();
    expect(resolved.value).toEqual({ version: "v0" });

    const snapshot = await runtime.consentActivation.read(nonConsentPolicy.policyKey);
    expect(snapshot.status).toBe("never-activated");
  });

  describe("authority lifecycle histories", () => {
    const histories = [
      {
        name: "empty",
        seed: async () => undefined,
        expect: (snapshot: Awaited<ReturnType<PolicyRuntime["consentActivation"]["read"]>>) => {
          expect(snapshot.status).toBe("never-activated");
          expect(snapshot.registered).toBe(false);
          expect(snapshot.guard.expectedVersion).toBe("no_stream");
        },
      },
      {
        name: "partial",
        seed: async (r: PolicyRuntime) => {
          await r.consentActivation.register(consentPolicy, context);
        },
        expect: (snapshot: Awaited<ReturnType<PolicyRuntime["consentActivation"]["read"]>>) => {
          expect(snapshot.status).toBe("never-activated");
          expect(snapshot.registered).toBe(true);
          expect(snapshot.guard.expectedVersion).toBe(1);
        },
      },
      {
        name: "terminal",
        seed: async (r: PolicyRuntime) => {
          await r.consentActivation.register(consentPolicy, context);
          await r.consentActivation.activate(
            consentPolicy,
            { version: "v1", documentId: "pol_terms", actorUserId: "usr_admin" },
            context,
          );
          await r.consentActivation.deactivate(consentPolicy, { actorUserId: "usr_admin" }, context);
        },
        expect: (snapshot: Awaited<ReturnType<PolicyRuntime["consentActivation"]["read"]>>) => {
          expect(snapshot.status).toBe("inactive");
          expect(snapshot.activeVersion).toBeNull();
          expect(snapshot.activationCount).toBe(1);
        },
      },
      {
        name: "repeated",
        seed: async (r: PolicyRuntime, store: EventStore) => {
          await r.consentActivation.register(consentPolicy, context);
          await store.appendToStream({
            streamId: consentActivationAuthorityStreamId(consentPolicy.policyKey),
            expectedVersion: "any",
            context,
            events: [
              {
                eventType: "platform-policy.consent-activation-authority.registered",
                payload: {
                  policyKey: consentPolicy.policyKey,
                  registration: {
                    contextName: "identity",
                    schemaSummary: "{ version: string }",
                    registeredAt: "2026-07-25T00:00:00.000Z",
                  },
                } as never,
              },
            ],
          });
        },
        expect: (snapshot: Awaited<ReturnType<PolicyRuntime["consentActivation"]["read"]>>) => {
          expect(snapshot.status).toBe("never-activated");
          expect(snapshot.registered).toBe(true);
          expect(snapshot.authorityVersion).toBe(2);
        },
      },
    ];

    it.each(histories)("rehydrates a $name authority history", async ({ seed, expect: assertSnapshot }) => {
      await seed(runtime, eventStore);
      assertSnapshot(await runtime.consentActivation.read(consentPolicy.policyKey));
    });

    const poisoned = [
      {
        name: "unexpected",
        eventType: "platform-policy.document.created",
        payload: { documentId: "pol_terms" },
        code: "unknown_event_type",
      },
      {
        name: "mismatched",
        eventType: "platform-policy.consent-activation-authority.registered",
        payload: {
          policyKey: nonConsentPolicy.policyKey,
          registration: {
            contextName: "pricing",
            schemaSummary: "{ version: string }",
            registeredAt: "2026-07-25T00:00:00.000Z",
          },
        },
        code: "policy_key_mismatch",
      },
      {
        name: "malformed-envelope",
        eventType: "platform-policy.consent-activation-authority.activated",
        payload: {
          policyKey: consentPolicy.policyKey,
          activation: {
            version: "v1",
            documentId: "pol_terms",
            activatedAt: "2026-07-25",
            actorUserId: "usr_admin",
          },
        },
        code: "invalid_activation_envelope",
      },
      {
        name: "activation-before-registration",
        eventType: "platform-policy.consent-activation-authority.activated",
        payload: {
          policyKey: consentPolicy.policyKey,
          activation: {
            version: "v1",
            documentId: "pol_terms",
            activatedAt: "2026-07-25T01:00:00.000Z",
            actorUserId: "usr_admin",
          },
        },
        code: "not_registered",
      },
    ];

    it.each(poisoned)("fails deterministically on a $name authority history", async ({ eventType, payload, code }) => {
      await eventStore.appendToStream({
        streamId: consentActivationAuthorityStreamId(consentPolicy.policyKey),
        expectedVersion: "no_stream",
        context,
        events: [{ eventType, payload: payload as never }],
      });

      await expect(runtime.consentActivation.read(consentPolicy.policyKey)).rejects.toMatchObject({
        name: "ConsentActivationAuthorityError",
        code,
      });
    });
  });

  it("serializes an interleaved guarded append against a concurrent activation", async () => {
    for (let iteration = 0; iteration < 8; iteration += 1) {
      await schema.reset();
      await schema.pool.query("TRUNCATE TABLE platform_policy_documents, platform_policy_document_history");
      await registerAndActivate("v1", "pol_terms");

      const guard = (await runtime.consentActivation.read(consentPolicy.policyKey)).guard;
      const consentStreamId = `identity.consent-cns_race_${iteration}`;
      const appendToStreams = eventStore.appendToStreams!;

      // The guard participant is first in the input list, so the guarded
      // transaction takes the authority row lock before writing anything.
      const guardedAppend = appendToStreams([
        runtime.consentActivation.guardAppendInput(guard, context),
        {
          streamId: consentStreamId,
          expectedVersion: "no_stream",
          context,
          events: [{ eventType: "identity.consent.recorded", payload: { consentId: `cns_race_${iteration}` } }],
        },
      ]).then(
        () => ({ committed: true as const }),
        (error: unknown) => ({ committed: false as const, error }),
      );

      const activation = runtime.consentActivation.activate(
        consentPolicy,
        { version: "v2", documentId: "pol_terms_v2", actorUserId: "usr_admin" },
        context,
      );

      const [guardedResult] = await Promise.all([guardedAppend, activation]);

      const consentEvents = await streamEvents(consentStreamId);
      const authorityEvents = await streamEvents(consentActivationAuthorityStreamId(consentPolicy.policyKey));
      const replacement = authorityEvents.find(
        (event) => event.eventType === "platform-policy.consent-activation-authority.replaced",
      );
      expect(replacement).toBeDefined();

      if (guardedResult.committed) {
        // Committing means the authority had not moved yet, so the consent
        // write must sit strictly before the replacement in the global order.
        expect(consentEvents).toHaveLength(1);
        expect(BigInt(consentEvents[0].globalPosition)).toBeLessThan(BigInt(replacement!.globalPosition));
      } else {
        expect(guardedResult.error).toMatchObject({ code: "concurrency_conflict" });
        expect(consentEvents).toHaveLength(0);
      }
    }
  });
});
