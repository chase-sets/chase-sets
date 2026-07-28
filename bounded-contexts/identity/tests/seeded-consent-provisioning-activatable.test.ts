import { describe, expect, it, vi } from "vitest";

/**
 * The same provisioning paths over a consent-activatable artifact, so the
 * shipped-corpus abstention proven in `seeded-consent-provisioning.test.ts` is
 * shown to be the publication rule rather than a permanently disabled path.
 * Exactly one build-time input is substituted: the compiled publication record.
 */
vi.mock("@chase-sets/public-docs", async (importOriginal) => {
  const original = await importOriginal<typeof import("@chase-sets/public-docs")>();
  return {
    ...original,
    publicPolicyPublicationRecords: {
      ...original.publicPolicyPublicationRecords,
      "terms-of-service": {
        ...original.publicPolicyPublicationRecords["terms-of-service"],
        publicationStatus: "published",
        effectiveAt: "2026-06-01T00:00:00.000Z",
        counselApprovalReference: "counsel-2026-06-01",
        consentActivatable: true,
      },
    },
  };
});

const { provisionAdminQaActorFixtures } = await import("../support/runtime-support/admin-qa-actor-fixtures");
const { isSeededConsentRecordable } = await import("../support/runtime-support/seeded-consent-activation");

type IdentityServices = import("../support/runtime-support/services").IdentityServices;

const SEEDED_POLICY_KEY = "terms-of-service";
const SEEDED_POLICY_VERSION = "v1";

function createCommandRecorder() {
  const records: { command?: { type?: string; policyKey?: string; subjectType?: string } }[] = [];
  const handler = vi.fn(async (envelope: unknown) => {
    records.push(envelope as (typeof records)[number]);
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
  };
}

describe("provisioning paths over a consent-activatable artifact", () => {
  it("reports the seeded consent as recordable", () => {
    expect(isSeededConsentRecordable(SEEDED_POLICY_KEY, SEEDED_POLICY_VERSION)).toBe(true);
  });

  it("activates the version it is about to record, then records one user-scoped Consent per fixture", async () => {
    const { services, consents, consentActivation } = createProvisioningServices();

    const results = await provisionAdminQaActorFixtures(services);

    expect(consentActivation.activate).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.createdConsent)).toBe(true);
    expect(consents.records).toHaveLength(6);
    expect(
      consents.records.every(
        (record) =>
          record.command?.type === "RecordConsent" &&
          record.command.policyKey === SEEDED_POLICY_KEY &&
          record.command.subjectType === "user",
      ),
    ).toBe(true);
  });
});
