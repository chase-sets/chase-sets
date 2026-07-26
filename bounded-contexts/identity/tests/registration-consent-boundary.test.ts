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

function createServices() {
  return {
    db: {
      // The display-name uniqueness read finds nothing; the reservation insert
      // returns its row so registration proceeds to the aggregate writes.
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("INSERT INTO identity_account_display_name_reservations")
          ? [{ display_name_key: "pokebash tcg" }]
          : [],
      })),
    },
    accounts: {
      commandHandler: vi.fn(async () => ({ version: 1, state: { status: "active" } })),
    },
    users: {
      getUserBySocialLogin: vi.fn(async () => null),
      commandHandler: vi.fn(async () => ({ version: 1, state: { status: "active" } })),
    },
    memberships: {
      commandHandler: vi.fn(async () => ({ version: 1, state: { status: "active" } })),
    },
    consents: {
      commandHandler: vi.fn(async () => ({ version: 1, state: { status: "recorded" } })),
    },
    policies: {
      // A newer version is active in the resolver than the one any resolution
      // below was minted with. Nothing in the registration path may consult it.
      resolvePolicy: vi.fn(async () => ({ value: { version: "v99" } })),
    },
    projectors: [],
  } as unknown as IdentityServices;
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

  return { status: response.status, body: await response.json() };
}

function expectNoIdentityWritten(services: IdentityServices) {
  expect(services.accounts.commandHandler, "no account may be written").not.toHaveBeenCalled();
  expect(services.users.commandHandler, "no user may be written").not.toHaveBeenCalled();
  expect(services.memberships.commandHandler, "no membership may be written").not.toHaveBeenCalled();
  expect(services.consents.commandHandler, "no consent may be written").not.toHaveBeenCalled();
  expect(services.db.query, "no display-name reservation may be written").not.toHaveBeenCalled();
}

function recordedConsents(services: IdentityServices) {
  return vi
    .mocked(services.consents.commandHandler)
    .mock.calls.map(([call]) => call.command as { policyKey: string; policyVersion: string })
    .map((command) => ({ policyKey: command.policyKey, policyVersion: command.policyVersion }));
}

describe("registration consent resolution boundary", () => {
  it("mints a signed, version-bearing resolution anonymously", async () => {
    const response = await buildIdentityApi(createServices()).request("/internal/auth/registration-consent");

    expect(response.status).toBe(200);
    const resolution = (await response.json()) as SignedRegistrationConsentResolution;
    expect(resolution.bundleKey).toBe(REGISTRATION_CONSENT_BUNDLE_KEY);
    expect(resolution.requirements).toEqual([]);
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
      const services = createServices();

      const { status, body } = await register(services, { registrationConsent: buildSubmission() });

      expect(status).toBe(400);
      expect(body.error?.code).toBe(REGISTRATION_CONSENT_NOT_SERVER_MINTED_CODE);
      expectNoIdentityWritten(services);
    });
  });

  it("rejects a registration with no resolution even when the bundle is empty", async () => {
    const services = createServices();

    const { status, body } = await register(services, {});

    expect(status).toBe(400);
    expect(body.error?.code).toBe(REGISTRATION_CONSENT_NOT_SERVER_MINTED_CODE);
    expect(body.error?.reason).toBe("absent");
    expectNoIdentityWritten(services);
  });

  it("rejects an arbitrary-path client that posts identity fields with no prior resolution", async () => {
    const services = createServices();

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
    const services = createServices();
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
    const services = createServices();

    const { status } = await register(services, {
      registrationConsent: { resolution: mint([]), affirmed: false },
    });

    expect(status).toBe(201);
    expect(services.accounts.commandHandler).toHaveBeenCalled();
    expect(services.memberships.commandHandler).toHaveBeenCalled();
    expect(recordedConsents(services)).toEqual([]);
  });

  it("records the minted requirement versions, not the currently active ones", async () => {
    const services = createServices();

    const { status } = await register(services, {
      registrationConsent: { resolution: mint([TERMS_V1]), affirmed: true },
    });

    expect(status).toBe(201);
    expect(recordedConsents(services)).toEqual([{ policyKey: "terms-of-service", policyVersion: "v1" }]);
    expect(services.policies.resolvePolicy, "the active version must never be consulted here").not.toHaveBeenCalled();
  });

  it("does not overwrite the submitted policy version with the currently active one", async () => {
    const services = createServices();

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
    const services = createServices();

    const { status } = await register(services, {
      registrationConsent: { resolution: mint([PRIVACY_V3, TERMS_V1]), affirmed: true },
    });

    expect(status).toBe(201);
    expect(recordedConsents(services)).toEqual([
      { policyKey: "privacy-policy", policyVersion: "v3" },
      { policyKey: "terms-of-service", policyVersion: "v1" },
    ]);
  });

  it("rejects an affirmation whose resolution was minted for different requirements", async () => {
    const services = createServices();
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
    const services = createServices();

    const { status, body } = await register(services, {
      registrationConsent: { resolution: mint([TERMS_V1]), affirmed: false },
    });

    expect(status).toBe(400);
    expect(body.error?.code).toBe(REGISTRATION_CONSENT_AFFIRMATION_REQUIRED_CODE);
    expectNoIdentityWritten(services);
  });

  it("rejects a resolution older than the freshness window", async () => {
    const services = createServices();
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
      const services = createServices();
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
      const services = createServices();
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
