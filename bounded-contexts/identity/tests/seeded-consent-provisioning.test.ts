import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { CONSENT_VERSION_NOT_CONSENT_ACTIVATABLE_CODE } from "../features/consents/domain/consent-bundle";
import { identityTermsOfServicePolicy } from "../features/consents/domain/terms-of-service-policy";
import { createConsentRuntime } from "../features/consents/api/runtime";
import type { IdentityRuntimeDeps } from "../support/runtime-support";
import type { IdentityServices } from "../support/runtime-support/services";
import { provisionAdminQaActorFixtures } from "../support/runtime-support/admin-qa-actor-fixtures";
import {
  ensureSeededConsentActivation,
  isSeededConsentRecordable,
} from "../support/runtime-support/seeded-consent-activation";

/**
 * The provisioning half of the recording admission, against the SHIPPED
 * publication corpus.
 *
 * Adding a rejection to `RecordConsent` changes a handler that seed, bootstrap
 * and fixture paths also invoke, so every one of them is exercised against the
 * new rule here rather than being assumed compatible. Nothing in this file
 * substitutes a corpus; the activatable counterpart is
 * `seeded-consent-provisioning-activatable.test.ts`.
 */

const SEEDED_POLICY_KEY = "terms-of-service";
const SEEDED_POLICY_VERSION = "v1";

const context: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: { performedByUserId: "usr_seed" as never, forAccountId: "acc_seed" as never },
  trace: {},
};

function createCommandRecorder() {
  const records: unknown[] = [];
  const handler = vi.fn(async (envelope: unknown) => {
    records.push(envelope);
    return { version: 1, state: {} };
  });
  return { handler, records };
}

function createProvisioningServices() {
  const accounts = createCommandRecorder();
  const users = createCommandRecorder();
  const memberships = createCommandRecorder();
  const consents = createCommandRecorder();
  const consentActivation = {
    read: vi.fn(async () => ({ status: "never-activated", activeVersion: null })),
    register: vi.fn(async () => ({ status: "never-activated", activeVersion: null })),
    activate: vi.fn(async () => ({ status: "active", activeVersion: SEEDED_POLICY_VERSION })),
  };
  const createPolicyDocument = vi.fn(async () => ({ documentId: "pol_seed_terms", version: 1 }));
  const resolvePolicy = vi.fn(async () => ({ documentId: null, value: { version: SEEDED_POLICY_VERSION } }));

  return {
    services: {
      accounts: { commandHandler: accounts.handler },
      users: { commandHandler: users.handler },
      memberships: { commandHandler: memberships.handler },
      consents: { commandHandler: consents.handler },
      policies: { consentActivation, createPolicyDocument, resolvePolicy },
      db: { query: vi.fn(async () => ({ rows: [] })) },
    } as unknown as IdentityServices,
    consents,
    consentActivation,
    createPolicyDocument,
  };
}

describe("provisioning paths against the shipped corpus", () => {
  it("reports the seeded consent as not recordable, from the admission rule itself", () => {
    expect(isSeededConsentRecordable(SEEDED_POLICY_KEY, SEEDED_POLICY_VERSION)).toBe(false);
  });

  it("does not activate a key whose artifact is not consent-activatable", async () => {
    const { services, consentActivation, createPolicyDocument } = createProvisioningServices();

    await ensureSeededConsentActivation(services, context, {
      policyKey: SEEDED_POLICY_KEY,
      version: SEEDED_POLICY_VERSION,
      actorUserId: "usr_seed",
      activatedAt: "2026-03-03T00:00:00.000Z",
    });

    expect(consentActivation.read).not.toHaveBeenCalled();
    expect(consentActivation.register).not.toHaveBeenCalled();
    expect(consentActivation.activate).not.toHaveBeenCalled();
    expect(createPolicyDocument).not.toHaveBeenCalled();
  });

  it("provisions the admin-QA actor matrix without activating or recording any Consent", async () => {
    const { services, consents, consentActivation } = createProvisioningServices();

    const results = await provisionAdminQaActorFixtures(services);

    expect(results).toHaveLength(6);
    expect(results.every((result) => result.createdAccount && result.createdUser && result.createdMembership)).toBe(
      true,
    );
    expect(results.every((result) => result.createdConsent === false)).toBe(true);
    expect(consents.records).toEqual([]);
    expect(consentActivation.activate).not.toHaveBeenCalled();
  });

  it("would be rejected, writing nothing, if a seed profile authored the fact anyway", async () => {
    // The exact command shape the scenario and representative seed profiles
    // construct, driven through the production consent runtime.
    const { eventStore, streams } = createInMemoryEventStore();
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as PgQueryable;
    const policies = createPolicyRuntime({ eventStore, db });
    const consents = createConsentRuntime({ eventStore, db, checkpointStore: {} } as unknown as IdentityRuntimeDeps);

    // Even with an operator having activated the key, as the pre-repair seed did.
    await policies.consentActivation.register(identityTermsOfServicePolicy, context);
    await policies.consentActivation.activate(
      identityTermsOfServicePolicy,
      { version: SEEDED_POLICY_VERSION, documentId: "pol_terms", actorUserId: "usr_seed" },
      context,
    );

    await expect(
      consents.commandHandler({
        streamId: "identity.consent-cns_seed_demo_terms",
        command: {
          type: "RecordConsent",
          consentId: "cns_seed_demo_terms" as never,
          subjectType: "user",
          userId: "usr_seed_demo" as never,
          accountId: "acc_seed_demo" as never,
          policyKey: SEEDED_POLICY_KEY,
          policyVersion: SEEDED_POLICY_VERSION,
          recordedAt: "2026-03-03T12:00:00.000Z",
        },
        context,
      }),
    ).rejects.toMatchObject({ code: CONSENT_VERSION_NOT_CONSENT_ACTIVATABLE_CODE });

    expect([...streams.keys()].filter((streamId) => streamId.startsWith("identity.consent-"))).toEqual([]);
  });
});
