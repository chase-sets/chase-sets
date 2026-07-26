import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPolicyCache, type PolicyDocumentCandidate } from "./cache";
import {
  ConsentActivationAuthorityError,
  consentActivationAuthorityStreamId,
  CONSENT_ACTIVATION_AUTHORITY_STREAM_PREFIX,
} from "./consent-activation-authority";
import { definePolicy, type PolicyDefinition } from "./define-policy";
import { createPolicyRuntime } from "./runtime";

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

const otherConsentPolicy: PolicyDefinition<ConsentValue> = definePolicy<ConsentValue>({
  policyKey: "identity.seller-agreement-active-version",
  contextName: "identity",
  schemaSummary: "{ version: string }",
  defaultValue: { version: "v0" },
  decodeValue: (raw) => ({ version: (raw as { version: string }).version }),
});

/** Reads never touch Postgres in this suite; the authority is stream-derived. */
const emptyDb = { query: async () => ({ rows: [], rowCount: 0 }) } as never;

function createHarness(cache = createPolicyCache()) {
  const { eventStore } = createInMemoryEventStore();
  const runtime = createPolicyRuntime({ eventStore, db: emptyDb, cache });
  return { eventStore, runtime, cache };
}

async function appendRawAuthorityEvent(
  eventStore: EventStore,
  policyKey: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  await eventStore.appendToStream({
    streamId: consentActivationAuthorityStreamId(policyKey),
    expectedVersion: "any",
    context,
    events: [{ eventType, payload: payload as never }],
  });
}

function registeredPayload(policyKey: string, overrides: Record<string, unknown> = {}) {
  return {
    policyKey,
    registration: {
      contextName: "identity",
      schemaSummary: "{ version: string }",
      registeredAt: "2026-07-25T00:00:00.000Z",
      ...overrides,
    },
  };
}

function activatedPayload(policyKey: string, version: string, overrides: Record<string, unknown> = {}) {
  return {
    policyKey,
    activation: {
      version,
      documentId: `pol_${version}`,
      activatedAt: "2026-07-25T01:00:00.000Z",
      actorUserId: "usr_admin",
      ...overrides,
    },
  };
}

describe("consent activation authority identity", () => {
  it("resolves a guardable inactive authority for a never-activated policy key", async () => {
    const { runtime } = createHarness();

    const snapshot = await runtime.consentActivation.read(consentPolicy.policyKey);

    // The identity is derived from the policy key alone -- no document id
    // participates, which is what makes it valid before first activation.
    expect(snapshot.streamId).toBe(`${CONSENT_ACTIVATION_AUTHORITY_STREAM_PREFIX}${consentPolicy.policyKey}`);
    expect(snapshot.streamId).toBe(consentActivationAuthorityStreamId(consentPolicy.policyKey));
    expect(snapshot.guard.streamId).toBe(snapshot.streamId);
    expect(snapshot.status).toBe("never-activated");
    expect(snapshot.isActive).toBe(false);
    expect(snapshot.registered).toBe(false);
    expect(snapshot.activeVersion).toBeNull();
    expect(snapshot.activeDocumentId).toBeNull();
    // The zero-event guard form: an unactivated key is a value with an
    // identity, not a missing row.
    expect(snapshot.authorityVersion).toBe(0);
    expect(snapshot.guard.expectedVersion).toBe("no_stream");
  });

  it("derives distinct stream identities per policy key without any document id", async () => {
    const { runtime } = createHarness();

    const first = await runtime.consentActivation.read(consentPolicy.policyKey);
    const second = await runtime.consentActivation.read(otherConsentPolicy.policyKey);

    expect(first.streamId).not.toBe(second.streamId);
    expect(first.streamId.startsWith(CONSENT_ACTIVATION_AUTHORITY_STREAM_PREFIX)).toBe(true);
    expect(second.streamId.startsWith(CONSENT_ACTIVATION_AUTHORITY_STREAM_PREFIX)).toBe(true);
  });

  it("rejects a policy key that is not a well-formed dotted key", async () => {
    const { runtime } = createHarness();

    await expect(runtime.consentActivation.read("NotAPolicyKey")).rejects.toMatchObject({
      name: "ConsentActivationAuthorityError",
      code: "invalid_policy_key",
    });
  });
});

describe("consent-capable registration is not activation", () => {
  it("registering a consent-capable key does not activate it", async () => {
    const { runtime } = createHarness();

    // The real no-options entry point: a definition and a context, nothing else.
    const snapshot = await runtime.consentActivation.register(consentPolicy, context);

    expect(snapshot.registered).toBe(true);
    expect(snapshot.status).toBe("never-activated");
    expect(snapshot.isActive).toBe(false);
    expect(snapshot.activeVersion).toBeNull();
    expect(snapshot.activationCount).toBe(0);
    // The container now exists and holds one event, and the key still reads
    // as not activated: presence is not completeness.
    expect(snapshot.authorityVersion).toBe(1);
    expect(snapshot.guard.expectedVersion).toBe(1);
  });

  it("an explicit activation does activate it", async () => {
    const { runtime } = createHarness();
    await runtime.consentActivation.register(consentPolicy, context);

    const snapshot = await runtime.consentActivation.activate(
      consentPolicy,
      { version: "v1", documentId: "pol_terms", actorUserId: "usr_admin", activatedAt: "2026-07-25T01:00:00.000Z" },
      context,
    );

    expect(snapshot.status).toBe("active");
    expect(snapshot.isActive).toBe(true);
    expect(snapshot.activeVersion).toBe("v1");
    expect(snapshot.activeDocumentId).toBe("pol_terms");
    expect(snapshot.activationCount).toBe(1);
  });

  it("refuses to activate a key that was never registered as consent-capable", async () => {
    const { runtime } = createHarness();

    await expect(
      runtime.consentActivation.activate(
        consentPolicy,
        { version: "v1", documentId: "pol_terms", actorUserId: "usr_admin" },
        context,
      ),
    ).rejects.toMatchObject({ name: "ConsentActivationAuthorityError", code: "not_registered" });
  });

  it("registering one consent-capable key leaves every other key inactive", async () => {
    const { runtime } = createHarness();

    await runtime.consentActivation.register(consentPolicy, context);
    await runtime.consentActivation.activate(
      consentPolicy,
      { version: "v1", documentId: "pol_terms", actorUserId: "usr_admin" },
      context,
    );
    await runtime.consentActivation.register(otherConsentPolicy, context);

    const other = await runtime.consentActivation.read(otherConsentPolicy.policyKey);
    expect(other.registered).toBe(true);
    expect(other.status).toBe("never-activated");
    expect(other.isActive).toBe(false);
  });
});

describe("presence is not completeness", () => {
  const fixtures = [
    {
      name: "empty",
      seed: async () => undefined,
      expected: { registered: false, status: "never-activated" as const, authorityVersion: 0 },
    },
    {
      name: "partial",
      seed: async (harness: Awaited<ReturnType<typeof createHarness>>) => {
        await harness.runtime.consentActivation.register(consentPolicy, context);
      },
      expected: { registered: true, status: "never-activated" as const, authorityVersion: 1 },
    },
    {
      name: "draft",
      seed: async (harness: Awaited<ReturnType<typeof createHarness>>) => {
        await harness.runtime.consentActivation.register(consentPolicy, context);
        // A draft policy document exists for the key. A document is the value;
        // it is never the activation.
        harness.cache.set(consentPolicy.policyKey, []);
      },
      expected: { registered: true, status: "never-activated" as const, authorityVersion: 1 },
    },
    {
      name: "activated-then-deactivated",
      seed: async (harness: Awaited<ReturnType<typeof createHarness>>) => {
        await harness.runtime.consentActivation.register(consentPolicy, context);
        await harness.runtime.consentActivation.activate(
          consentPolicy,
          { version: "v1", documentId: "pol_terms", actorUserId: "usr_admin" },
          context,
        );
        await harness.runtime.consentActivation.deactivate(consentPolicy, { actorUserId: "usr_admin" }, context);
      },
      expected: { registered: true, status: "inactive" as const, authorityVersion: 3 },
    },
  ];

  it.each(fixtures)("reads $name authority contents as not activated", async ({ seed, expected }) => {
    const harness = createHarness();
    await seed(harness);

    const snapshot = await harness.runtime.consentActivation.read(consentPolicy.policyKey);

    expect(snapshot.registered).toBe(expected.registered);
    expect(snapshot.status).toBe(expected.status);
    expect(snapshot.isActive).toBe(false);
    expect(snapshot.activeVersion).toBeNull();
    expect(snapshot.authorityVersion).toBe(expected.authorityVersion);
  });

  it("distinguishes a deactivated key from a never-activated one", async () => {
    const { runtime } = createHarness();
    await runtime.consentActivation.register(consentPolicy, context);
    await runtime.consentActivation.activate(
      consentPolicy,
      { version: "v1", documentId: "pol_terms", actorUserId: "usr_admin" },
      context,
    );
    await runtime.consentActivation.deactivate(consentPolicy, { actorUserId: "usr_admin" }, context);

    const snapshot = await runtime.consentActivation.read(consentPolicy.policyKey);

    expect(snapshot.status).toBe("inactive");
    expect(snapshot.status).not.toBe("never-activated");
    // A deactivated key was activated once, which a never-activated key was not.
    expect(snapshot.activationCount).toBe(1);
  });

  it("reconciles a repeated registration with matching metadata instead of skipping it", async () => {
    const { runtime } = createHarness();
    await runtime.consentActivation.register(consentPolicy, context);

    const snapshot = await runtime.consentActivation.register(consentPolicy, context);

    expect(snapshot.registered).toBe(true);
    expect(snapshot.status).toBe("never-activated");
    // Converged rather than appended a second registration.
    expect(snapshot.authorityVersion).toBe(1);
  });

  it("fails closed on a repeated registration with conflicting metadata", async () => {
    const { runtime } = createHarness();
    await runtime.consentActivation.register(consentPolicy, context);

    const conflicting = definePolicy<ConsentValue>({
      policyKey: consentPolicy.policyKey,
      contextName: "marketplace",
      schemaSummary: "{ version: string }",
      defaultValue: { version: "v0" },
      decodeValue: (raw) => ({ version: (raw as { version: string }).version }),
    });

    await expect(runtime.consentActivation.register(conflicting, context)).rejects.toMatchObject({
      name: "ConsentActivationAuthorityError",
      code: "registration_conflict",
    });
  });
});

describe("guardable transitions", () => {
  const transitions = [
    {
      name: "first-activate",
      seed: async (runtime: ReturnType<typeof createPolicyRuntime>) => {
        await runtime.consentActivation.register(consentPolicy, context);
      },
      apply: async (runtime: ReturnType<typeof createPolicyRuntime>) => {
        await runtime.consentActivation.activate(
          consentPolicy,
          { version: "v1", documentId: "pol_v1", actorUserId: "usr_admin" },
          context,
        );
      },
    },
    {
      name: "replace",
      seed: async (runtime: ReturnType<typeof createPolicyRuntime>) => {
        await runtime.consentActivation.register(consentPolicy, context);
        await runtime.consentActivation.activate(
          consentPolicy,
          { version: "v1", documentId: "pol_v1", actorUserId: "usr_admin" },
          context,
        );
      },
      apply: async (runtime: ReturnType<typeof createPolicyRuntime>) => {
        await runtime.consentActivation.activate(
          consentPolicy,
          { version: "v2", documentId: "pol_v2", actorUserId: "usr_admin" },
          context,
        );
      },
    },
    {
      name: "deactivate",
      seed: async (runtime: ReturnType<typeof createPolicyRuntime>) => {
        await runtime.consentActivation.register(consentPolicy, context);
        await runtime.consentActivation.activate(
          consentPolicy,
          { version: "v1", documentId: "pol_v1", actorUserId: "usr_admin" },
          context,
        );
      },
      apply: async (runtime: ReturnType<typeof createPolicyRuntime>) => {
        await runtime.consentActivation.deactivate(consentPolicy, { actorUserId: "usr_admin" }, context);
      },
    },
    {
      name: "re-activate",
      seed: async (runtime: ReturnType<typeof createPolicyRuntime>) => {
        await runtime.consentActivation.register(consentPolicy, context);
        await runtime.consentActivation.activate(
          consentPolicy,
          { version: "v1", documentId: "pol_v1", actorUserId: "usr_admin" },
          context,
        );
        await runtime.consentActivation.deactivate(consentPolicy, { actorUserId: "usr_admin" }, context);
      },
      apply: async (runtime: ReturnType<typeof createPolicyRuntime>) => {
        await runtime.consentActivation.activate(
          consentPolicy,
          { version: "v2", documentId: "pol_v2", actorUserId: "usr_admin" },
          context,
        );
      },
    },
  ];

  it.each(transitions)("a guard minted before $name rejects afterwards", async ({ seed, apply }) => {
    const { eventStore, runtime } = createHarness();
    await seed(runtime);

    const before = await runtime.consentActivation.read(consentPolicy.policyKey);
    await apply(runtime);
    const after = await runtime.consentActivation.read(consentPolicy.policyKey);

    expect(after.guard.expectedVersion).not.toBe(before.guard.expectedVersion);

    const appendToStreams = eventStore.appendToStreams!;
    await expect(
      appendToStreams([
        {
          streamId: "identity.consent-cns_probe",
          expectedVersion: "no_stream",
          context,
          events: [{ eventType: "identity.consent.recorded", payload: { consentId: "cns_probe" } }],
        },
        runtime.consentActivation.guardAppendInput(before.guard, context),
      ]),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });

    // Nothing was written to any stream in the rejected transaction.
    expect(await eventStore.readStream({ streamId: "identity.consent-cns_probe" })).toHaveLength(0);
    const authorityEvents = await eventStore.readStream({ streamId: after.streamId });
    expect(authorityEvents).toHaveLength(after.authorityVersion);
  });

  it("commits a guarded append while the authority is unchanged", async () => {
    const { eventStore, runtime } = createHarness();
    await runtime.consentActivation.register(consentPolicy, context);
    await runtime.consentActivation.activate(
      consentPolicy,
      { version: "v1", documentId: "pol_v1", actorUserId: "usr_admin" },
      context,
    );

    const snapshot = await runtime.consentActivation.read(consentPolicy.policyKey);
    const appendToStreams = eventStore.appendToStreams!;

    await appendToStreams([
      {
        streamId: "identity.consent-cns_ok",
        expectedVersion: "no_stream",
        context,
        events: [
          {
            eventType: "identity.consent.recorded",
            payload: { consentId: "cns_ok", policyVersion: snapshot.activeVersion },
          },
        ],
      },
      runtime.consentActivation.guardAppendInput(snapshot.guard, context),
    ]);

    expect(await eventStore.readStream({ streamId: "identity.consent-cns_ok" })).toHaveLength(1);
    // The guard contributes no history to the authority stream.
    expect(await eventStore.readStream({ streamId: snapshot.streamId })).toHaveLength(snapshot.authorityVersion);
  });

  it("rejects a never-activated guard once the key is first activated", async () => {
    const { eventStore, runtime } = createHarness();

    const before = await runtime.consentActivation.read(consentPolicy.policyKey);
    expect(before.guard.expectedVersion).toBe("no_stream");

    await runtime.consentActivation.register(consentPolicy, context);
    await runtime.consentActivation.activate(
      consentPolicy,
      { version: "v1", documentId: "pol_v1", actorUserId: "usr_admin" },
      context,
    );

    const appendToStreams = eventStore.appendToStreams!;
    await expect(
      appendToStreams([
        {
          streamId: "identity.account-acc_probe",
          expectedVersion: "no_stream",
          context,
          events: [{ eventType: "identity.account.created", payload: { accountId: "acc_probe" } }],
        },
        runtime.consentActivation.guardAppendInput(before.guard, context),
      ]),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });

    expect(await eventStore.readStream({ streamId: "identity.account-acc_probe" })).toHaveLength(0);
  });
});

describe("one authoritative read", () => {
  it("never pairs a cached policy value with an independently read authority revision", async () => {
    const cache = createPolicyCache();
    const { runtime } = createHarness(cache);

    await runtime.consentActivation.register(consentPolicy, context);
    await runtime.consentActivation.activate(
      consentPolicy,
      { version: "v1", documentId: "pol_v1", actorUserId: "usr_admin" },
      context,
    );

    // Warm the resolver cache with the stale v1 candidate, then advance the
    // authority to v2 without touching the cache -- the exact disagreement
    // shape that recorded a stale v1 against authority revision 2.
    const staleCandidate: PolicyDocumentCandidate = {
      documentId: "pol_v1",
      value: { version: "v1" },
      effectiveFrom: "2026-07-01T00:00:00.000Z",
      effectiveUntil: null,
    };
    cache.set(consentPolicy.policyKey, [staleCandidate]);

    await runtime.consentActivation.activate(
      consentPolicy,
      { version: "v2", documentId: "pol_v2", actorUserId: "usr_admin" },
      context,
    );

    const resolved = await runtime.resolvePolicy(consentPolicy);
    const snapshot = await runtime.consentActivation.read(consentPolicy.policyKey);

    // The cache is still stale, and that is fine: it carries the policy VALUE.
    expect(resolved.value.version).toBe("v1");
    expect(resolved.documentId).toBe("pol_v1");

    // The authority's version and its guard come from the same replay, so the
    // stale value can never be handed out with the newer revision.
    expect(snapshot.activeVersion).toBe("v2");
    expect(snapshot.activeDocumentId).toBe("pol_v2");
    expect(snapshot.guard.expectedVersion).toBe(snapshot.authorityVersion);
    expect(snapshot.authorityVersion).toBe(3);

    // A resolved policy exposes no guard or revision token, so no caller can
    // assemble the stale pairing from the public surface.
    expect(Object.keys(resolved)).not.toContain("guard");
    expect(Object.keys(resolved)).not.toContain("expectedVersion");
    expect(Object.keys(resolved)).not.toContain("authorityVersion");
  });

  it("mints the guard from the same replay that produced the state", async () => {
    const { eventStore, runtime } = createHarness();
    await runtime.consentActivation.register(consentPolicy, context);

    const snapshot = await runtime.consentActivation.read(consentPolicy.policyKey);
    const streamEvents = await eventStore.readStream({ streamId: snapshot.streamId });

    expect(snapshot.authorityVersion).toBe(streamEvents.length);
    expect(snapshot.guard.expectedVersion).toBe(streamEvents.length);
  });
});

describe("poisoned authority history", () => {
  it("rejects an unknown event type on the authority stream", async () => {
    const { eventStore, runtime } = createHarness();
    await appendRawAuthorityEvent(eventStore, consentPolicy.policyKey, "platform-policy.document.created", {
      documentId: "pol_v1",
    });

    await expect(runtime.consentActivation.read(consentPolicy.policyKey)).rejects.toMatchObject({
      code: "unknown_event_type",
    });
  });

  it("rejects an event whose policy key does not match its stream", async () => {
    const { eventStore, runtime } = createHarness();
    await appendRawAuthorityEvent(
      eventStore,
      consentPolicy.policyKey,
      "platform-policy.consent-activation-authority.registered",
      registeredPayload(otherConsentPolicy.policyKey),
    );

    await expect(runtime.consentActivation.read(consentPolicy.policyKey)).rejects.toMatchObject({
      code: "policy_key_mismatch",
    });
  });

  it("rejects an activation recorded before registration", async () => {
    const { eventStore, runtime } = createHarness();
    await appendRawAuthorityEvent(
      eventStore,
      consentPolicy.policyKey,
      "platform-policy.consent-activation-authority.activated",
      activatedPayload(consentPolicy.policyKey, "v1"),
    );

    await expect(runtime.consentActivation.read(consentPolicy.policyKey)).rejects.toMatchObject({
      code: "not_registered",
    });
  });

  it("rejects a deactivation of a version that was not active", async () => {
    const { eventStore, runtime } = createHarness();
    await runtime.consentActivation.register(consentPolicy, context);
    await runtime.consentActivation.activate(
      consentPolicy,
      { version: "v1", documentId: "pol_v1", actorUserId: "usr_admin" },
      context,
    );
    await appendRawAuthorityEvent(
      eventStore,
      consentPolicy.policyKey,
      "platform-policy.consent-activation-authority.deactivated",
      {
        policyKey: consentPolicy.policyKey,
        deactivation: {
          deactivatedVersion: "v9",
          deactivatedAt: "2026-07-25T02:00:00.000Z",
          actorUserId: "usr_admin",
        },
      },
    );

    await expect(runtime.consentActivation.read(consentPolicy.policyKey)).rejects.toMatchObject({
      code: "invalid_transition",
    });
  });

  it("rejects a repeated activation that should have been a replacement", async () => {
    const { eventStore, runtime } = createHarness();
    await runtime.consentActivation.register(consentPolicy, context);
    await runtime.consentActivation.activate(
      consentPolicy,
      { version: "v1", documentId: "pol_v1", actorUserId: "usr_admin" },
      context,
    );
    await appendRawAuthorityEvent(
      eventStore,
      consentPolicy.policyKey,
      "platform-policy.consent-activation-authority.activated",
      activatedPayload(consentPolicy.policyKey, "v2"),
    );

    await expect(runtime.consentActivation.read(consentPolicy.policyKey)).rejects.toMatchObject({
      code: "invalid_transition",
    });
  });

  it("rejects a replacement of a version that was not active", async () => {
    const { eventStore, runtime } = createHarness();
    await runtime.consentActivation.register(consentPolicy, context);
    await runtime.consentActivation.activate(
      consentPolicy,
      { version: "v1", documentId: "pol_v1", actorUserId: "usr_admin" },
      context,
    );
    await appendRawAuthorityEvent(
      eventStore,
      consentPolicy.policyKey,
      "platform-policy.consent-activation-authority.replaced",
      { ...activatedPayload(consentPolicy.policyKey, "v3"), previousVersion: "v2" },
    );

    await expect(runtime.consentActivation.read(consentPolicy.policyKey)).rejects.toMatchObject({
      code: "invalid_transition",
    });
  });

  it("converges a byte-identical repeated registration", async () => {
    const { eventStore, runtime } = createHarness();
    await runtime.consentActivation.register(consentPolicy, context);
    await appendRawAuthorityEvent(
      eventStore,
      consentPolicy.policyKey,
      "platform-policy.consent-activation-authority.registered",
      registeredPayload(consentPolicy.policyKey),
    );

    const snapshot = await runtime.consentActivation.read(consentPolicy.policyKey);

    expect(snapshot.registered).toBe(true);
    expect(snapshot.status).toBe("never-activated");
    expect(snapshot.authorityVersion).toBe(2);
  });

  it("rejects a repeated registration whose metadata contradicts the recorded one", async () => {
    const { eventStore, runtime } = createHarness();
    await runtime.consentActivation.register(consentPolicy, context);
    await appendRawAuthorityEvent(
      eventStore,
      consentPolicy.policyKey,
      "platform-policy.consent-activation-authority.registered",
      registeredPayload(consentPolicy.policyKey, { contextName: "marketplace" }),
    );

    await expect(runtime.consentActivation.read(consentPolicy.policyKey)).rejects.toMatchObject({
      code: "registration_conflict",
    });
  });
});

describe("activation envelope validation", () => {
  const malformed = [
    {
      name: "nested-unknown",
      payload: () => activatedPayload(consentPolicy.policyKey, "v1", { unexpectedField: "x" }),
    },
    {
      name: "top-level-unknown",
      payload: () => ({ ...activatedPayload(consentPolicy.policyKey, "v1"), extra: "x" }),
    },
    {
      name: "date-only-instant",
      payload: () => activatedPayload(consentPolicy.policyKey, "v1", { activatedAt: "2026-07-25" }),
    },
    {
      name: "zoneless-instant",
      payload: () => activatedPayload(consentPolicy.policyKey, "v1", { activatedAt: "2026-07-25T01:00:00.000" }),
    },
    {
      name: "out-of-range-instant",
      payload: () => activatedPayload(consentPolicy.policyKey, "v1", { activatedAt: "1970-01-01T00:00:00.000Z" }),
    },
    {
      name: "over-long-version",
      payload: () => activatedPayload(consentPolicy.policyKey, "v".repeat(65)),
    },
    {
      name: "non-string-version",
      payload: () => activatedPayload(consentPolicy.policyKey, "v1", { version: 1 }),
    },
    {
      name: "nested-object-where-token-expected",
      payload: () => activatedPayload(consentPolicy.policyKey, "v1", { documentId: { id: "pol_v1" } }),
    },
    {
      name: "missing-activation-record",
      payload: () => ({ policyKey: consentPolicy.policyKey }),
    },
    {
      name: "array-activation-record",
      payload: () => ({ policyKey: consentPolicy.policyKey, activation: [] }),
    },
  ];

  it.each(malformed)("rejects a $name activation envelope with an explicit error", async ({ payload }) => {
    const { eventStore, runtime } = createHarness();
    await runtime.consentActivation.register(consentPolicy, context);
    await appendRawAuthorityEvent(
      eventStore,
      consentPolicy.policyKey,
      "platform-policy.consent-activation-authority.activated",
      payload() as Record<string, unknown>,
    );

    const error = await runtime.consentActivation.read(consentPolicy.policyKey).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConsentActivationAuthorityError);
    expect((error as ConsentActivationAuthorityError).code).toBe("invalid_activation_envelope");
  });

  it("rejects a malformed envelope rather than inventing a fallback activation", async () => {
    const { eventStore, runtime } = createHarness();
    await runtime.consentActivation.register(consentPolicy, context);
    await appendRawAuthorityEvent(
      eventStore,
      consentPolicy.policyKey,
      "platform-policy.consent-activation-authority.activated",
      activatedPayload(consentPolicy.policyKey, "v1", { activatedAt: "2026-07-25" }),
    );

    await expect(runtime.consentActivation.read(consentPolicy.policyKey)).rejects.toThrow(
      ConsentActivationAuthorityError,
    );
  });

  it("refuses to activate with a malformed version through the command path", async () => {
    const { runtime } = createHarness();
    await runtime.consentActivation.register(consentPolicy, context);

    await expect(
      runtime.consentActivation.activate(
        consentPolicy,
        { version: "not a version", documentId: "pol_v1", actorUserId: "usr_admin" },
        context,
      ),
    ).rejects.toMatchObject({ code: "invalid_activation_envelope" });
  });
});
