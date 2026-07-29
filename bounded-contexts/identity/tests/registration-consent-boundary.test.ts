import { describe, expect, it, vi } from "vitest";
import type { IdentityServices } from "../support/runtime-support/services";
import { buildIdentityApi } from "../api";
import {
  mintRegistrationConsentResolution,
  REGISTRATION_CONSENT_AFFIRMATION_REQUIRED_CODE,
  REGISTRATION_CONSENT_BUNDLE_KEY,
  REGISTRATION_CONSENT_EXPIRED_CODE,
  REGISTRATION_CONSENT_FRESHNESS_WINDOW_MS,
  REGISTRATION_CONSENT_NOT_SERVER_MINTED_CODE,
  type RegistrationConsentRequirement,
  type SignedRegistrationConsentResolution,
} from "../features/consents/domain/registration-consent";
import { resolveRegistrationConsentSigningKeys } from "../support/runtime-support/registration-consent-signing";
import {
  activateConsentPolicyForTest,
  replaceConsentPolicyVersionForTest,
} from "../features/consents/domain/consent-bundle-test-support";
import { createInMemoryEventStore, type InMemoryEventStore } from "./in-memory-event-store";

// Registration records only bundle members that are published AND activated, so
// this suite's two members are published (at the exact versions its resolutions
// are minted with) and their activation authorities are activated in
// `createServices`. The boundary under test is unchanged: the recorded versions
// must be the MINTED ones, never the ones a policy resolver reports.
vi.mock("@chase-sets/public-docs", async (importOriginal) => {
  const { publicDocsWithConsentActivatable } =
    await import("../features/consents/domain/consent-publication-test-support");
  return publicDocsWithConsentActivatable(importOriginal, ["terms-of-service", "privacy-policy"], {
    "privacy-policy": "v3",
  });
});

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

const operatorContext = {
  tenantId: "tnt_identity",
  audit: { performedByUserId: "usr_policy_operator", forAccountId: "acc_policy_operator" },
  trace: {},
} as never;

/**
 * Registration now compares the WHOLE current registration bundle against the
 * whole signed one, so a suite's activation state is part of what each case
 * asserts rather than a fixed backdrop: `activate` is exactly the set of
 * requirements the bundle currently resolves to.
 */
async function createServices(activate: readonly RegistrationConsentRequirement[] = [TERMS_V1, PRIVACY_V3]) {
  // Registration composes its participants into one all-or-nothing append, so
  // the store itself is what these assertions observe.
  const eventStore = createInMemoryEventStore();
  for (const requirement of activate) {
    await activateConsentPolicyForTest(
      eventStore,
      requirement.policyKey as "privacy-policy" | "terms-of-service",
      requirement.version,
      operatorContext,
    );
  }

  return {
    eventStore,
    db: {
      // The display-name uniqueness read finds nothing; the reservation upsert
      // returns its row so registration proceeds to the aggregate writes.
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("INSERT INTO identity_account_display_name_reservations")
          ? [{ display_name_key: "pokebash tcg" }]
          : [],
      })),
    },
    users: {
      getUserBySocialLogin: vi.fn(async () => null),
    },
    policies: {
      // A newer version is active in the resolver than the one any resolution
      // below was minted with. Nothing in the registration path may consult it.
      resolvePolicy: vi.fn(async () => ({ value: { version: "v99" } })),
    },
    projectors: [],
  } as unknown as IdentityServices;
}

function store(services: IdentityServices) {
  return services.eventStore as InMemoryEventStore;
}

function mint(
  requirements: readonly RegistrationConsentRequirement[] = [],
  resolvedAt = new Date().toISOString(),
): SignedRegistrationConsentResolution {
  return mintRegistrationConsentResolution({
    requirements,
    resolvedAt,
    signingKeys: resolveRegistrationConsentSigningKeys(),
  });
}

async function register(
  services: IdentityServices,
  body: Readonly<Record<string, unknown>>,
): Promise<Readonly<{ status: number; body: { error?: { code?: string; reason?: string } } }>> {
  const response = await buildIdentityApi(services).request("/internal/auth/personal-identities", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "owner@pokebash.example",
      displayName: "PokeBash TCG",
      ...body,
    }),
  });

  // A rejection the route does not classify surfaces as the framework's
  // plain-text 500, so the body is parsed only when it is actually JSON.
  const text = await response.text();
  try {
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  } catch {
    return { status: response.status, body: {} };
  }
}

function expectNoIdentityWritten(services: IdentityServices) {
  expect(store(services).streamIdsWithPrefix("identity."), "no identity stream may be written").toEqual([]);
  expect(services.db.query, "no display-name reservation may be written").not.toHaveBeenCalled();
}

function recordedConsents(services: IdentityServices) {
  const eventStore = store(services);
  return eventStore
    .streamIdsWithPrefix("identity.consent-")
    .flatMap((streamId) => eventStore.streams.get(streamId) ?? [])
    .map((event) => event.payload as unknown as { policyKey: string; policyVersion: string })
    .map((payload) => ({ policyKey: payload.policyKey, policyVersion: payload.policyVersion }));
}

describe("registration consent resolution boundary", () => {
  it("mints a signed, version-bearing resolution anonymously", async () => {
    const response = await buildIdentityApi(await createServices()).request("/internal/auth/registration-consent");

    expect(response.status).toBe(200);
    const resolution = (await response.json()) as SignedRegistrationConsentResolution;
    expect(resolution.bundleKey).toBe(REGISTRATION_CONSENT_BUNDLE_KEY);
    // The mint resolves the registration Consent Bundle: in this suite's world
    // both members are published and activated, so both are required, in the
    // bundle's declared order. Against the shipped corpus the same route mints
    // an empty ordered set -- covered in the Consent Bundle suites.
    expect(resolution.requirements).toEqual([TERMS_V1, PRIVACY_V3]);
    expect(resolution.signature).toEqual(expect.any(String));
    expect(resolution.signature.length).toBeGreaterThan(0);
    expect(resolution.resolvedAt).toMatch(/Z$/);
  });

  describe("a resolution the server did not mint is rejected before any aggregate write", () => {
    const tamperShapes: readonly (readonly [string, () => unknown])[] = [
      [
        "a tampered requirements entry",
        () => {
          const resolution = mint([TERMS_V1]);
          return {
            resolution: { ...resolution, requirements: [{ ...TERMS_V1, version: "v2" }] },
            affirmed: true,
          };
        },
      ],
      [
        "a reordered requirements array",
        () => {
          const resolution = mint([TERMS_V1, PRIVACY_V3]);
          return {
            resolution: { ...resolution, requirements: [PRIVACY_V3, TERMS_V1] },
            affirmed: true,
          };
        },
      ],
      [
        "a tampered resolvedAt",
        () => {
          const resolution = mint([TERMS_V1]);
          return {
            resolution: { ...resolution, resolvedAt: new Date(Date.now() - 1_000).toISOString() },
            affirmed: true,
          };
        },
      ],
      [
        "a stripped signature",
        () => {
          const { signature: _signature, ...unsigned } = mint([TERMS_V1]);
          return { resolution: unsigned, affirmed: true };
        },
      ],
      [
        "a signature from a foreign key",
        () => ({
          resolution: mintRegistrationConsentResolution({
            requirements: [TERMS_V1],
            resolvedAt: new Date().toISOString(),
            signingKeys: "an-attacker-controlled-signing-key",
          }),
          affirmed: true,
        }),
      ],
      [
        "a hand-authored payload",
        () => ({
          resolution: {
            bundleKey: REGISTRATION_CONSENT_BUNDLE_KEY,
            requirements: [TERMS_V1],
            resolvedAt: new Date().toISOString(),
            signature: "hand-authored",
          },
          affirmed: true,
        }),
      ],
    ];

    it.each(tamperShapes)("rejects %s", async (_label, buildSubmission) => {
      const services = await createServices();

      const { status, body } = await register(services, { registrationConsent: buildSubmission() });

      expect(status).toBe(400);
      expect(body.error?.code).toBe(REGISTRATION_CONSENT_NOT_SERVER_MINTED_CODE);
      expectNoIdentityWritten(services);
    });
  });

  it("rejects a registration with no resolution even when the bundle is empty", async () => {
    const services = await createServices([]);

    const { status, body } = await register(services, {});

    expect(status).toBe(400);
    expect(body.error?.code).toBe(REGISTRATION_CONSENT_NOT_SERVER_MINTED_CODE);
    expect(body.error?.reason).toBe("absent");
    expectNoIdentityWritten(services);
  });

  it("rejects an arbitrary-path client that posts identity fields with no prior resolution", async () => {
    const services = await createServices();

    const { status, body } = await register(services, {
      email: "arbitrary@pokebash.example",
      displayName: "Arbitrary Path Client",
      phone: "+15555550123",
      givenName: "Arbitrary",
      familyName: "Client",
    });

    expect(status).toBe(400);
    expect(body.error?.code).toBe(REGISTRATION_CONSENT_NOT_SERVER_MINTED_CODE);
    expectNoIdentityWritten(services);
  });

  it("rejects a caller-local impostor binder with the same code as an absent resolution", async () => {
    const services = await createServices();
    // A caller-local `registrationConsentSubmission()` returning a
    // plausibly-shaped unsigned object: the shape is right, the provenance is
    // not, and the route cannot tell the difference between this and bringing
    // nothing at all -- which is the point.
    const registrationConsentSubmission = () => ({
      resolution: {
        bundleKey: REGISTRATION_CONSENT_BUNDLE_KEY,
        requirements: [],
        resolvedAt: new Date().toISOString(),
        signature: "locally-minted",
      },
      affirmed: true,
    });

    const { status, body } = await register(services, {
      registrationConsent: registrationConsentSubmission(),
    });

    expect(status).toBe(400);
    expect(body.error?.code).toBe(REGISTRATION_CONSENT_NOT_SERVER_MINTED_CODE);
    expectNoIdentityWritten(services);
  });

  it("accepts a signed empty resolution and records no consent", async () => {
    // Nothing is activated, so the current bundle really is empty and the empty
    // signed set still matches it exactly.
    const services = await createServices([]);

    const { status } = await register(services, {
      registrationConsent: { resolution: mint([]), affirmed: false },
    });

    expect(status).toBe(201);
    expect(store(services).streamIdsWithPrefix("identity.account-")).toHaveLength(1);
    expect(store(services).streamIdsWithPrefix("identity.membership-")).toHaveLength(1);
    expect(recordedConsents(services)).toEqual([]);
  });

  it("records the minted requirement versions, not the currently active ones", async () => {
    const services = await createServices([TERMS_V1]);

    const { status } = await register(services, {
      registrationConsent: { resolution: mint([TERMS_V1]), affirmed: true },
    });

    expect(status).toBe(201);
    expect(recordedConsents(services)).toEqual([{ policyKey: "terms-of-service", policyVersion: "v1" }]);
    expect(services.policies.resolvePolicy, "the active version must never be consulted here").not.toHaveBeenCalled();
  });

  it("does not overwrite the submitted policy version with the currently active one", async () => {
    const services = await createServices([TERMS_V1]);

    // Under the deleted override this registration recorded the resolver's
    // active version (v99) for the canonical Terms of Service key, discarding
    // the v1 the caller was actually given.
    const { status } = await register(services, {
      registrationConsent: { resolution: mint([TERMS_V1]), affirmed: true },
    });

    expect(status).toBe(201);
    expect(recordedConsents(services).map((consent) => consent.policyVersion)).toEqual(["v1"]);
    expect(recordedConsents(services).map((consent) => consent.policyVersion)).not.toContain("v99");
  });

  it("records every requirement in its signed order", async () => {
    const services = await createServices();

    const { status } = await register(services, {
      registrationConsent: { resolution: mint([TERMS_V1, PRIVACY_V3]), affirmed: true },
    });

    expect(status).toBe(201);
    expect(recordedConsents(services)).toEqual([
      { policyKey: "terms-of-service", policyVersion: "v1" },
      { policyKey: "privacy-policy", policyVersion: "v3" },
    ]);
  });

  it("rejects a signed set whose order is not the bundle's declared order", async () => {
    const services = await createServices();

    // Declared order IS the resolved order, so a resolution carrying the two
    // members the other way round cannot be the current bundle -- and the
    // comparison is ordered, not set-wise.
    const { status } = await register(services, {
      registrationConsent: { resolution: mint([PRIVACY_V3, TERMS_V1]), affirmed: true },
    });

    expect(status).toBe(500);
    expectNoIdentityWritten(services);
  });

  describe("the signed bundle is revalidated against the WHOLE current bundle", () => {
    it("rejects an empty signed bundle once a member has been activated", async () => {
      // Minted while nothing was activated -- a legitimately signed, fresh,
      // affirmation-free empty resolution. Then a member is activated. The
      // signed value names nothing, so there is nothing in it to revalidate:
      // only comparing the whole current set catches this.
      const services = await createServices([]);
      const resolution = mint([]);
      await activateConsentPolicyForTest(store(services), "terms-of-service", TERMS_V1.version, operatorContext);

      const { status } = await register(services, {
        registrationConsent: { resolution, affirmed: false },
      });

      expect(status).toBe(500);
      expectNoIdentityWritten(services);
      expect(recordedConsents(services)).toEqual([]);
    });

    it("rejects a signed bundle that is missing a member activated after the mint", async () => {
      const services = await createServices([TERMS_V1]);
      const resolution = mint([TERMS_V1]);
      await activateConsentPolicyForTest(store(services), "privacy-policy", PRIVACY_V3.version, operatorContext);

      const { status } = await register(services, {
        registrationConsent: { resolution, affirmed: true },
      });

      expect(status).toBe(500);
      expectNoIdentityWritten(services);
    });

    it("still accepts a signed bundle that the current bundle exactly matches", async () => {
      const services = await createServices();

      const { status } = await register(services, {
        registrationConsent: { resolution: mint([TERMS_V1, PRIVACY_V3]), affirmed: true },
      });

      expect(status).toBe(201);
      expect(recordedConsents(services)).toHaveLength(2);
    });
  });

  describe("an exact retry of a committed registration stays idempotent", () => {
    it("returns the prior result after the authority moves, without a second consent", async () => {
      const services = await createServices([TERMS_V1, PRIVACY_V3]);
      const submission = { resolution: mint([TERMS_V1, PRIVACY_V3]), affirmed: true };

      const first = await register(services, { registrationConsent: submission });
      expect(first.status).toBe(201);
      const consentStreamsAfterFirst = store(services).streamIdsWithPrefix("identity.consent-");
      expect(consentStreamsAfterFirst).toHaveLength(2);

      // The activation moves AFTER the registration committed. Retrying the
      // exact same request with the exact same token must still answer with the
      // identity that already exists.
      await replaceConsentPolicyVersionForTest(store(services), "terms-of-service", "v1", "v2", operatorContext);

      const retry = await register(services, { registrationConsent: submission });

      expect(retry.status).toBe(201);
      expect(store(services).streamIdsWithPrefix("identity.consent-")).toEqual(consentStreamsAfterFirst);
      expect(recordedConsents(services)).toEqual([
        { policyKey: "terms-of-service", policyVersion: "v1" },
        { policyKey: "privacy-policy", policyVersion: "v3" },
      ]);
    });

    it("still rejects a FRESH submission of that same old token", async () => {
      const services = await createServices([TERMS_V1, PRIVACY_V3]);
      const submission = { resolution: mint([TERMS_V1, PRIVACY_V3]), affirmed: true };
      await replaceConsentPolicyVersionForTest(store(services), "terms-of-service", "v1", "v2", operatorContext);

      const { status } = await register(services, { registrationConsent: submission });

      expect(status).toBe(500);
      expectNoIdentityWritten(services);
    });
  });

  it("rejects an affirmation whose resolution was minted for different requirements", async () => {
    const services = await createServices();
    const mintedForTerms = mint([TERMS_V1]);

    // Affirming a different requirement set than the one that was signed means
    // swapping the requirements under the signature -- there is no shape in
    // which the affirmation names a set the resolution does not.
    const { status, body } = await register(services, {
      registrationConsent: {
        resolution: { ...mintedForTerms, requirements: [PRIVACY_V3] },
        affirmed: true,
      },
    });

    expect(status).toBe(400);
    expect(body.error?.code).toBe(REGISTRATION_CONSENT_NOT_SERVER_MINTED_CODE);
    expectNoIdentityWritten(services);
  });

  it("rejects an unaffirmed resolution that carries requirements", async () => {
    const services = await createServices();

    const { status, body } = await register(services, {
      registrationConsent: { resolution: mint([TERMS_V1]), affirmed: false },
    });

    expect(status).toBe(400);
    expect(body.error?.code).toBe(REGISTRATION_CONSENT_AFFIRMATION_REQUIRED_CODE);
    expectNoIdentityWritten(services);
  });

  it("rejects a resolution older than the freshness window", async () => {
    const services = await createServices();
    const staleAt = new Date(Date.now() - REGISTRATION_CONSENT_FRESHNESS_WINDOW_MS - 60_000).toISOString();

    const { status, body } = await register(services, {
      registrationConsent: { resolution: mint([], staleAt), affirmed: false },
    });

    expect(status).toBe(400);
    expect(body.error?.code).toBe(REGISTRATION_CONSENT_EXPIRED_CODE);
    expectNoIdentityWritten(services);
  });

  it("still verifies a resolution minted under a retired key during rotation", async () => {
    const retired = "retired-registration-consent-key";
    const current = "current-registration-consent-key";
    const resolution = mintRegistrationConsentResolution({
      requirements: [],
      resolvedAt: new Date().toISOString(),
      signingKeys: retired,
    });

    process.env.REGISTRATION_CONSENT_SIGNING_SECRET = current;
    process.env.REGISTRATION_CONSENT_PREVIOUS_SIGNING_SECRETS = retired;
    try {
      const services = await createServices([]);
      const { status } = await register(services, {
        registrationConsent: { resolution, affirmed: false },
      });

      expect(status).toBe(201);
    } finally {
      delete process.env.REGISTRATION_CONSENT_SIGNING_SECRET;
      delete process.env.REGISTRATION_CONSENT_PREVIOUS_SIGNING_SECRETS;
    }
  });

  it("rejects a resolution signed by a key that has left the rotation", async () => {
    const evicted = "evicted-registration-consent-key";
    const resolution = mintRegistrationConsentResolution({
      requirements: [],
      resolvedAt: new Date().toISOString(),
      signingKeys: evicted,
    });

    process.env.REGISTRATION_CONSENT_SIGNING_SECRET = "current-registration-consent-key";
    try {
      const services = await createServices([]);
      const { status, body } = await register(services, {
        registrationConsent: { resolution, affirmed: false },
      });

      expect(status).toBe(400);
      expect(body.error?.code).toBe(REGISTRATION_CONSENT_NOT_SERVER_MINTED_CODE);
      expectNoIdentityWritten(services);
    } finally {
      delete process.env.REGISTRATION_CONSENT_SIGNING_SECRET;
    }
  });
});
