import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { publicPolicyPublicationRecords } from "@chase-sets/public-docs";
import { createPersonalIdentityForAuth } from "../api";
import {
  resolveGuardedRegistrationConsentSnapshot,
  type ConsentPublicationRegistry,
  type RegistrationConsentSubmission,
} from "../features/consents/domain/consent-activation";
import type { IdentityServices } from "../support/runtime-support/services";

const context: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_registration" as never,
    forAccountId: "acc_registration" as never,
  },
  trace: {},
};

function activeRegistrationPublications(): ConsentPublicationRegistry {
  return {
    ...publicPolicyPublicationRecords,
    "terms-of-service": {
      ...publicPolicyPublicationRecords["terms-of-service"],
      publicationStatus: "published",
      consentActivatable: true,
    },
    "privacy-policy": {
      ...publicPolicyPublicationRecords["privacy-policy"],
      publicationStatus: "published",
      consentActivatable: true,
    },
  } satisfies ConsentPublicationRegistry;
}

async function createHarness(options: Readonly<{ active?: boolean; eventStore?: EventStore }> = {}) {
  const memory = createInMemoryEventStore();
  const eventStore = options.eventStore ?? memory.eventStore;
  const publications = options.active ? activeRegistrationPublications() : publicPolicyPublicationRecords;
  const policyDocuments = {
    "identity.terms-of-service-active-version": "pol_terms",
    "identity.privacy-policy-active-version": "pol_privacy",
  } as const;

  if (options.active) {
    for (const documentId of Object.values(policyDocuments)) {
      await memory.eventStore.appendToStream({
        streamId: `platform-policy.document-${documentId}`,
        expectedVersion: "no_stream",
        events: [{ eventType: "platform-policy.document.created", payload: { documentId } }],
        context,
      });
    }
  }

  const policies = {
    resolvePolicy: vi.fn(async (definition: { policyKey: keyof typeof policyDocuments }) => ({
      policyKey: definition.policyKey,
      value: { version: "v1" },
      source: "policy" as const,
      documentId: policyDocuments[definition.policyKey],
      effectiveFrom: "2026-07-24T00:00:00.000Z",
      effectiveUntil: null,
      resolvedAt: "2026-07-24T00:00:00.000Z",
    })),
  };
  const db = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  };
  const services = {
    db,
    eventStore,
    policies,
  } as unknown as IdentityServices;
  const resolved = await resolveGuardedRegistrationConsentSnapshot(policies, memory.eventStore, publications);

  return { memory, services, db, policies, publications, resolved };
}

function submission(
  resolved: Awaited<ReturnType<typeof createHarness>>["resolved"],
  overrides: Readonly<{ operationId?: string; affirmed?: boolean }> = {},
): RegistrationConsentSubmission {
  return {
    operationId: overrides.operationId ?? "cmd_registration",
    snapshot: resolved.snapshot,
    affirmed: overrides.affirmed ?? true,
  };
}

function registrationParams(registrationConsent: RegistrationConsentSubmission) {
  return {
    email: "new.user@chasesets.test",
    displayName: "New User",
    registrationConsent,
    context,
  } as const;
}

function registrationEvents(memory: ReturnType<typeof createInMemoryEventStore>) {
  return memory.readAllEvents().filter((event) => event.eventType.startsWith("identity."));
}

describe("atomic registration consent", () => {
  it("rejects a missing required affirmation before any registration write", async () => {
    const harness = await createHarness({ active: true });

    await expect(
      createPersonalIdentityForAuth(
        harness.services,
        registrationParams(submission(harness.resolved, { affirmed: false })),
        harness.publications,
      ),
    ).rejects.toThrow(/requires affirmation/);

    expect(harness.db.query).not.toHaveBeenCalled();
    expect(registrationEvents(harness.memory)).toEqual([]);
  });

  it("commits Account, User, Membership, and the ordered Consent bundle in one append", async () => {
    const harness = await createHarness({ active: true });
    const result = await createPersonalIdentityForAuth(
      harness.services,
      registrationParams(submission(harness.resolved)),
      harness.publications,
    );

    expect(result.snapshots.map((snapshot) => snapshot.aggregate)).toEqual([
      "account",
      "membership",
      "consent",
      "consent",
      "user",
    ]);
    expect(
      registrationEvents(harness.memory)
        .filter((event) => event.eventType === "identity.consent.recorded")
        .map((event) => ({
          policyKey: event.payload.policyKey,
          policyVersion: event.payload.policyVersion,
          subjectType: event.payload.subjectType,
          userId: event.payload.userId,
          accountId: event.payload.accountId,
        })),
    ).toEqual([
      {
        policyKey: "terms-of-service",
        policyVersion: "v1",
        subjectType: "user",
        userId: result.userId,
        accountId: result.accountId,
      },
      {
        policyKey: "privacy-policy",
        policyVersion: "v1",
        subjectType: "user",
        userId: result.userId,
        accountId: result.accountId,
      },
    ]);
  });

  it("leaves no partial state on a forced second-Consent failure, then retries to one completed result", async () => {
    const memory = createInMemoryEventStore();
    let failSecondConsent = true;
    const eventStore: EventStore = {
      ...memory.eventStore,
      appendToStreams: async (inputs) => {
        if (
          failSecondConsent &&
          inputs.filter((input) => input.streamId.startsWith("identity.consent-")).length === 2
        ) {
          failSecondConsent = false;
          throw new Error("forced second Consent failure");
        }
        return memory.eventStore.appendToStreams!(inputs);
      },
    };
    const harness = await createHarness({ active: true, eventStore });
    for (const event of harness.memory.readAllEvents()) {
      if (event.streamId.startsWith("platform-policy.document-")) {
        await memory.eventStore.appendToStream({
          streamId: event.streamId,
          expectedVersion: "no_stream",
          events: [{ eventType: event.eventType, payload: event.payload }],
          context,
        });
      }
    }
    const input = registrationParams(submission(harness.resolved));

    await expect(createPersonalIdentityForAuth(harness.services, input, harness.publications)).rejects.toThrow(
      /forced second Consent/,
    );
    expect(registrationEvents(memory)).toEqual([]);

    const completed = await createPersonalIdentityForAuth(harness.services, input, harness.publications);
    const retried = await createPersonalIdentityForAuth(harness.services, input, harness.publications);

    expect(retried).toEqual(completed);
    expect(registrationEvents(memory).filter((event) => event.eventType === "identity.account.created")).toHaveLength(
      1,
    );
    expect(registrationEvents(memory).filter((event) => event.eventType === "identity.user.created")).toHaveLength(1);
    expect(
      registrationEvents(memory).filter((event) => event.eventType === "identity.membership.granted"),
    ).toHaveLength(1);
    expect(registrationEvents(memory).filter((event) => event.eventType === "identity.consent.recorded")).toHaveLength(
      2,
    );
  });

  it("collapses concurrent attempts with one operation identity to one aggregate set", async () => {
    const harness = await createHarness({ active: true });
    const input = registrationParams(submission(harness.resolved));

    const [left, right] = await Promise.all([
      createPersonalIdentityForAuth(harness.services, input, harness.publications),
      createPersonalIdentityForAuth(harness.services, input, harness.publications),
    ]);

    expect(right).toEqual(left);
    expect(
      registrationEvents(harness.memory).filter((event) => event.eventType === "identity.account.created"),
    ).toHaveLength(1);
    expect(
      registrationEvents(harness.memory).filter(
        (event) => event.eventType === "identity.personal-identity.provisioned",
      ),
    ).toHaveLength(1);
  });

  it("rejects a mid-flight activation switch before appending registration state", async () => {
    const harness = await createHarness({ active: true });
    harness.policies.resolvePolicy.mockClear().mockImplementation(async (definition: { policyKey: string }) => ({
      policyKey: definition.policyKey,
      value: { version: harness.policies.resolvePolicy.mock.calls.length > 2 ? "v2" : "v1" },
      source: "policy" as const,
      documentId: definition.policyKey.includes("terms") ? "pol_terms" : "pol_privacy",
      effectiveFrom: "2026-07-24T00:00:00.000Z",
      effectiveUntil: null,
      resolvedAt: "2026-07-24T00:00:00.000Z",
    }));

    await expect(
      createPersonalIdentityForAuth(
        harness.services,
        registrationParams(submission(harness.resolved)),
        harness.publications,
      ),
    ).rejects.toThrow(/bundle is stale/);

    expect(registrationEvents(harness.memory)).toEqual([]);
  });

  it("uses policy stream versions as append-time guards against a last-instant revision", async () => {
    const memory = createInMemoryEventStore();
    let reviseBeforeAppend = true;
    const eventStore: EventStore = {
      ...memory.eventStore,
      appendToStreams: async (inputs) => {
        if (reviseBeforeAppend) {
          reviseBeforeAppend = false;
          await memory.eventStore.appendToStream({
            streamId: "platform-policy.document-pol_terms",
            expectedVersion: 1,
            events: [{ eventType: "platform-policy.document.revised", payload: { version: "v2" } }],
            context,
          });
        }
        return memory.eventStore.appendToStreams!(inputs);
      },
    };
    const harness = await createHarness({ active: true, eventStore });
    for (const documentId of ["pol_terms", "pol_privacy"]) {
      await memory.eventStore.appendToStream({
        streamId: `platform-policy.document-${documentId}`,
        expectedVersion: "no_stream",
        events: [{ eventType: "platform-policy.document.created", payload: { documentId } }],
        context,
      });
    }

    await expect(
      createPersonalIdentityForAuth(
        harness.services,
        registrationParams(submission(harness.resolved)),
        harness.publications,
      ),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });

    expect(registrationEvents(memory)).toEqual([]);
  });

  it("creates the identity without Consent facts for an exact empty bundle", async () => {
    const harness = await createHarness();
    const result = await createPersonalIdentityForAuth(
      harness.services,
      registrationParams(submission(harness.resolved, { affirmed: false })),
      harness.publications,
    );

    expect(result.snapshots.some((snapshot) => snapshot.aggregate === "account")).toBe(true);
    expect(
      registrationEvents(harness.memory).filter((event) => event.eventType === "identity.consent.recorded"),
    ).toEqual([]);
    expect(harness.policies.resolvePolicy).not.toHaveBeenCalled();
  });
});
