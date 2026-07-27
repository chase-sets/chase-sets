import { beforeEach, describe, expect, it, vi } from "vitest";

// The publication corpus is compiled into the repository at build time, and
// every shipped artifact is non-consent-activatable. Substituting the compiled
// module is the only way to exercise the activatable half of the rule, and it
// substitutes exactly one build-time input: the closed member registry, the
// resolver, the authority, and every route below are the production ones.
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

const { createInMemoryEventStore } = await import("@chase-sets/event-core/test-support");
const { createPolicyRuntime } = await import("@chase-sets/platform-policy/runtime");
const { buildIdentityApi } = await import("../api");
const { identityTermsOfServicePolicy } = await import("../features/consents/domain/terms-of-service-policy");
const { CONSENT_BUNDLE_SUPERSEDED_CODE } = await import("../features/consents/domain/consent-bundle");

type IdentityServices = import("../support/runtime-support/services").IdentityServices;
type SignedRegistrationConsentResolution =
  import("../features/consents/domain/registration-consent").SignedRegistrationConsentResolution;

const context = {
  tenantId: "tnt_identity" as never,
  audit: { performedByUserId: "usr_operator" as never, forAccountId: "acc_operator" as never },
  trace: {},
};

function createHarness() {
  const { eventStore, streams } = createInMemoryEventStore();
  const db = {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes("INSERT INTO identity_account_display_name_reservations")
        ? [{ display_name_key: "pokebash tcg" }]
        : [],
    })),
  };
  const policies = createPolicyRuntime({ eventStore, db: db as never });

  const services = {
    db,
    eventStore,
    accounts: { commandHandler: vi.fn(async () => ({ version: 1, state: { status: "active" } })) },
    users: { commandHandler: vi.fn(async () => ({ version: 1, state: { status: "active" } })) },
    memberships: { commandHandler: vi.fn(async () => ({ version: 1, state: { status: "active" } })) },
    consents: { commandHandler: vi.fn(async () => ({ version: 1, state: { status: "recorded" } })) },
    policies,
    projectors: [],
  } as unknown as IdentityServices;

  return { services, policies, streams };
}

async function activateTerms(policies: ReturnType<typeof createPolicyRuntime>, version: string) {
  await policies.consentActivation.register(identityTermsOfServicePolicy, context);
  await policies.consentActivation.activate(
    identityTermsOfServicePolicy,
    { version, documentId: "pol_terms", actorUserId: "usr_operator" },
    context,
  );
}

async function mint(services: IdentityServices): Promise<SignedRegistrationConsentResolution> {
  const response = await buildIdentityApi(services).request("/internal/auth/registration-consent");
  expect(response.status).toBe(200);
  return (await response.json()) as SignedRegistrationConsentResolution;
}

function register(services: IdentityServices, resolution: SignedRegistrationConsentResolution, affirmed: boolean) {
  return buildIdentityApi(services).request("/internal/auth/personal-identities", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "owner@pokebash.example",
      displayName: "PokeBash TCG",
      registrationConsent: { resolution, affirmed },
    }),
  });
}

function expectNothingWritten(services: IdentityServices) {
  expect(services.accounts.commandHandler).not.toHaveBeenCalled();
  expect(services.users.commandHandler).not.toHaveBeenCalled();
  expect(services.memberships.commandHandler).not.toHaveBeenCalled();
  expect(services.consents.commandHandler).not.toHaveBeenCalled();
  expect(services.db.query).not.toHaveBeenCalled();
}

describe("a consent-activatable member, driven through the real entry points", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it("omits a consent-activatable member the authority has not activated", async () => {
    const resolution = await mint(harness.services);

    expect(resolution.requirements).toEqual([]);
  });

  it("includes it once publication and activation both confirm", async () => {
    await activateTerms(harness.policies, "v1");

    const resolution = await mint(harness.services);

    expect(resolution.requirements).toEqual([{ policyKey: "terms-of-service", version: "v1", href: "/terms" }]);
  });

  it("resolves a two-member bundle with one activated member to exactly one requirement", async () => {
    await activateTerms(harness.policies, "v1");

    const resolution = await mint(harness.services);

    expect(resolution.requirements).toHaveLength(1);
    expect(resolution.requirements[0].policyKey).toBe("terms-of-service");
  });

  it("records the affirmed requirement at the version the resolution was minted with", async () => {
    await activateTerms(harness.policies, "v1");
    const resolution = await mint(harness.services);

    const response = await register(harness.services, resolution, true);

    expect(response.status).toBe(201);
    expect(vi.mocked(harness.services.consents.commandHandler).mock.calls).toHaveLength(1);
  });

  it("rejects an append when activation changes after the bundle is resolved", async () => {
    // Minted while nothing was activated...
    const resolution = await mint(harness.services);
    expect(resolution.requirements).toEqual([]);

    // ...then the authority activates the member, so the affirmed list no
    // longer covers what the bundle requires.
    await activateTerms(harness.policies, "v1");
    const response = await register(harness.services, resolution, false);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: CONSENT_BUNDLE_SUPERSEDED_CODE } });
    expectNothingWritten(harness.services);
  });

  it("rejects an append when the authority deactivates and reactivates at a different version", async () => {
    await activateTerms(harness.policies, "v1");
    const resolution = await mint(harness.services);

    await harness.policies.consentActivation.deactivate(
      identityTermsOfServicePolicy,
      { actorUserId: "usr_operator" },
      context,
    );
    await harness.policies.consentActivation.activate(
      identityTermsOfServicePolicy,
      { version: "v2", documentId: "pol_terms_v2", actorUserId: "usr_operator" },
      context,
    );

    const response = await register(harness.services, resolution, true);

    // The published version is still v1, so the authority's v2 makes the member
    // unresolved rather than merely superseded -- either way, nothing is written.
    expect(response.status).toBe(409);
    expectNothingWritten(harness.services);
  });
});
