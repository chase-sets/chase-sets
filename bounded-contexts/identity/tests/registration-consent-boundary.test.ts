import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
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
import { createInMemoryEventStore, type InMemoryEventStore } from "./in-memory-event-store";
import {
  assertRegistrationConsentDeclaration,
  bindRegistrationConsentSubject,
  identityConsentPolicyPublications,
  resolveConsentBundle,
  resolveConsentBundleAgainstCorpus,
  type RegistrationConsentBundles,
} from "../features/consents/domain/consent-bundle";
import {
  activeSnapshot,
  activeRegistrationConsentFixture,
  registrationConsentBundlesFixture,
} from "./consent-activation-authority-fixtures";
import { identityConsentActiveVersionPolicies } from "../features/consents/domain/terms-of-service-policy";
import { createIdentityBootstrapContext } from "../support/runtime-support/bootstrap-context";

function buildApp(services: IdentityServices) {
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/", buildIdentityApi(services));
  return app;
}

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
    // Registration composes its participants into one all-or-nothing append, so
    // the store itself is what these assertions observe.
    eventStore: createInMemoryEventStore(),
    registrationConsentBundles: registrationConsentBundlesFixture(),
    db: {
      // The display-name uniqueness read finds nothing; the reservation upsert
      // returns its row so registration proceeds to the aggregate writes.
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("INSERT INTO identity_account_display_name_reservations")
          ? [{ display_name_key: "pokebash tcg" }]
          : [],
      })),
    },
    users: {},
    policies: {
      // Cached document values are not Consent Activation Authority.
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
  const response = await buildApp(services).request("/internal/auth/personal-identities", {
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
  it.each(["terms-of-service", "privacy-policy"] as const)(
    "guards every participant against %s authority movement",
    async (policyKey) => {
      const services = createServices();
      const fixture = await activeRegistrationConsentFixture(store(services), services.db, {
        "terms-of-service": "v1",
        "privacy-policy": "v3",
      });
      Object.assign(services, fixture);
      const original = services.registrationConsentBundles.forRegistration;
      let moved = false;
      vi.spyOn(services.registrationConsentBundles, "forRegistration").mockImplementation(async (subject) => {
        const bound = await original(subject);
        if (!moved) {
          moved = true;
          await services.policies.consentActivation.deactivate(
            identityConsentActiveVersionPolicies[policyKey],
            {
              actorUserId: "usr_test_operator",
            },
            createIdentityBootstrapContext(),
          );
        }
        return bound;
      });
      const append = vi.spyOn(store(services), "appendToStreams");
      const response = await register(services, {
        registrationConsent: { resolution: mint([TERMS_V1, PRIVACY_V3]), affirmed: true },
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatchObject({ code: "registration_consent_expired", reason: "superseded" });
      expect(append).toHaveBeenCalledOnce();
      expect(append.mock.calls[0][0]).toHaveLength(8);
      expect(store(services).streamIdsWithPrefix("identity.")).toEqual([]);
    },
  );

  it("complete committed recovery retains the exact zero-event participant guard set without resolving authority", async () => {
    const services = createServices();
    Object.assign(
      services,
      await activeRegistrationConsentFixture(store(services), services.db, {
        "terms-of-service": "v1",
        "privacy-policy": "v3",
      }),
    );
    const submission = { registrationConsent: { resolution: mint([TERMS_V1, PRIVACY_V3]), affirmed: true } };
    const first = await register(services, submission);
    expect(first.status).toBe(201);
    const expected = store(services)
      .streamIdsWithPrefix("identity.")
      .filter((streamId) => /^identity\.(registration-operation|account|user|membership|consent)-/.test(streamId))
      .map((streamId) => ({
        streamId,
        expectedVersion: store(services).streams.get(streamId)!.at(-1)!.streamVersion,
        events: [],
      }));
    expect(expected).toHaveLength(6);
    const append = vi.spyOn(store(services), "appendToStreams");
    const bind = vi.spyOn(services.registrationConsentBundles, "forRegistration");
    expect(await register(services, submission)).toEqual(first);
    expect(append).toHaveBeenCalledOnce();
    expect(
      append.mock.calls[0][0].map(({ streamId, expectedVersion, events }) => ({ streamId, expectedVersion, events })),
    ).toEqual(expected);
    expect(bind).not.toHaveBeenCalled();
  });

  it("rejects a decisive 501st participant event with the exact Layer-1 body", async () => {
    const services = createServices();
    const submission = { registrationConsent: { resolution: mint(), affirmed: false } };
    expect((await register(services, submission)).status).toBe(201);
    const streamId = store(services).streamIdsWithPrefix("identity.account-")[0];
    await store(services).appendToStream({
      streamId,
      expectedVersion: 1,
      context: createIdentityBootstrapContext(),
      events: [
        ...Array.from({ length: 499 }, () => ({
          eventType: "identity.account.profile-updated",
          payload: { name: "", displayName: "PokeBash TCG" },
        })),
        { eventType: "identity.account.closed", payload: { closedAt: new Date().toISOString() } },
      ],
    });
    expect(store(services).streams.get(streamId)).toHaveLength(501);
    const append = vi.spyOn(store(services), "appendToStreams");
    const before = [...store(services).streams.entries()];
    expect(await register(services, submission)).toEqual({
      status: 409,
      body: {
        error: {
          code: "registration_operation_participant_disagreement",
          message: "This registration operation contains a participant that disagrees with its claim.",
        },
      },
    });
    expect(append).not.toHaveBeenCalled();
    expect([...store(services).streams.entries()]).toEqual(before);
  });

  it("retains the exact contact-required Layer-1 body", async () => {
    expect(
      await register(createServices(), {
        email: null,
        phone: null,
        registrationConsent: { resolution: mint(), affirmed: false },
      }),
    ).toEqual({
      status: 400,
      body: {
        error: {
          code: "registration_operation_contact_required",
          message: "A verified email or phone is required to register a personal identity.",
        },
      },
    });
  });

  it.each(["seller", "forged", "unresolved"] as const)(
    "rejects %s at both mounted declaration consumers",
    async (kind) => {
      const seller = await resolveConsentBundleAgainstCorpus(
        { read: async (key) => activeSnapshot(key, "v2") },
        "seller-onboarding",
        {
          ...identityConsentPolicyPublications,
          "seller-agreement": {
            ...identityConsentPolicyPublications["seller-agreement"],
            version: "v2",
            consentActivatable: true,
          },
        },
      );
      const guardsRead = vi.fn(() => []);
      const candidate =
        kind === "seller"
          ? seller
          : {
              bundleKey: "registration",
              subjectScope: "user",
              resolved: kind !== "unresolved",
              requirements: [],
              outcomes: [],
              get guards() {
                return guardsRead();
              },
            };
      const bundles = {
        resolve: vi.fn(async () => candidate),
        forRegistration: vi.fn(async (subject: Parameters<RegistrationConsentBundles["forRegistration"]>[0]) => ({
          declaration: candidate,
          subject,
        })),
      } as unknown as RegistrationConsentBundles;
      const services = { ...createServices(), registrationConsentBundles: bundles };
      const append = vi.spyOn(store(services), "appendToStreams");
      const get = await buildApp(services).request("/internal/auth/registration-consent");
      expect(get.status).toBe(500);
      expect(await get.json()).toEqual({ error: { code: "internal_error", message: "Internal server error." } });
      const post = await register(services, { registrationConsent: { resolution: mint(), affirmed: false } });
      expect(post.status).toBe(500);
      expect(post.body).toEqual({ error: { code: "internal_error", message: "Internal server error." } });
      expect(append).not.toHaveBeenCalled();
      expect(guardsRead).not.toHaveBeenCalled();
      expectNoIdentityWritten(services);
    },
  );

  it.each(["userId", "accountId"] as const)("rejects genuine POST issuance for another %s", async (field) => {
    const declaration = await resolveConsentBundle({ read: vi.fn() }, "registration");
    assertRegistrationConsentDeclaration(declaration);
    const forRegistration = vi.fn<RegistrationConsentBundles["forRegistration"]>(async (subject) =>
      bindRegistrationConsentSubject(declaration, {
        ...subject,
        ...(field === "userId" ? { userId: "usr_other" as UserId } : { accountId: "acc_other" as AccountId }),
      }),
    );
    const services = {
      ...createServices(),
      registrationConsentBundles: { resolve: async () => declaration, forRegistration },
    };
    const append = vi.spyOn(store(services), "appendToStreams");
    const response = await register(services, { registrationConsent: { resolution: mint(), affirmed: false } });
    expect(response.status).toBe(500);
    expect(forRegistration).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
    expectNoIdentityWritten(services);
  });

  it("rejects an unclaimed submitted list superseded by the canonical empty bundle", async () => {
    const declaration = await resolveConsentBundle({ read: vi.fn() }, "registration");
    assertRegistrationConsentDeclaration(declaration);
    const services = {
      ...createServices(),
      registrationConsentBundles: {
        resolve: async () => declaration,
        forRegistration: async (subject: Parameters<RegistrationConsentBundles["forRegistration"]>[0]) =>
          bindRegistrationConsentSubject(declaration, subject),
      },
    };
    const response = await register(services, {
      registrationConsent: { resolution: mint([TERMS_V1]), affirmed: true },
    });
    expect(response).toEqual({
      status: 400,
      body: {
        error: {
          code: "registration_consent_expired",
          reason: "superseded",
          message: "The registration consent resolution no longer matches the current required bundle.",
        },
      },
    });
    expectNoIdentityWritten(services);
  });

  it("mints a signed, version-bearing resolution anonymously", async () => {
    const response = await buildIdentityApi(createServices()).request("/internal/auth/registration-consent");

    expect(response.status).toBe(200);
    const resolution = (await response.json()) as SignedRegistrationConsentResolution;
    expect(resolution.bundleKey).toBe(REGISTRATION_CONSENT_BUNDLE_KEY);
    expect(resolution.requirements).toEqual([]);
    expect(resolution.signature).toEqual(expect.any(String));
    expect(resolution.signature.length).toBeGreaterThan(0);
    expect(resolution.resolvedAt).toMatch(/Z$/);
    expect(Object.keys(resolution).sort()).toEqual(["bundleKey", "requirements", "resolvedAt", "signature"]);
  });

  it("mints the exact canonical ordered active bundle without a subject carrier in transport", async () => {
    const services = createServices();
    Object.assign(
      services,
      await activeRegistrationConsentFixture(store(services), services.db, {
        "terms-of-service": "v1",
        "privacy-policy": "v3",
      }),
    );
    const declaration = await services.registrationConsentBundles.resolve();
    const response = await buildApp(services).request("/internal/auth/registration-consent");
    expect(response.status).toBe(200);
    const resolution = await response.json();
    expect(Object.keys(resolution).sort()).toEqual(["bundleKey", "requirements", "resolvedAt", "signature"]);
    expect(resolution.requirements).toEqual(declaration.requirements);
    expect(resolution.requirements.map(({ policyKey }: RegistrationConsentRequirement) => policyKey)).toEqual([
      "terms-of-service",
      "privacy-policy",
    ]);
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
    expect(store(services).streamIdsWithPrefix("identity.account-")).toHaveLength(1);
    expect(store(services).streamIdsWithPrefix("identity.membership-")).toHaveLength(1);
    expect(recordedConsents(services)).toEqual([]);
  });

  it("records the canonical signed versions without consulting cached policy values", async () => {
    const services = createServices();
    Object.assign(
      services,
      await activeRegistrationConsentFixture(store(services), services.db, { "terms-of-service": "v1" }),
    );
    const cachedPolicy = vi.spyOn(services.policies, "resolvePolicy");

    const { status } = await register(services, {
      registrationConsent: { resolution: mint([TERMS_V1]), affirmed: true },
    });

    expect(status).toBe(201);
    expect(recordedConsents(services)).toEqual([{ policyKey: "terms-of-service", policyVersion: "v1" }]);
    expect(cachedPolicy, "cached policy values must not be consulted").not.toHaveBeenCalled();
  });

  it("does not overwrite the submitted policy version with the currently active one", async () => {
    const services = createServices();
    Object.assign(
      services,
      await activeRegistrationConsentFixture(store(services), services.db, { "terms-of-service": "v99" }),
    );

    // Under the deleted override this registration recorded the resolver's
    // active version (v99) for the canonical Terms of Service key, discarding
    // the v1 the caller was actually given.
    const { status } = await register(services, {
      registrationConsent: { resolution: mint([TERMS_V1]), affirmed: true },
    });

    expect(status).toBe(400);
    expect(recordedConsents(services)).toEqual([]);
  });

  it("records every requirement in its signed order", async () => {
    const services = createServices();
    Object.assign(
      services,
      await activeRegistrationConsentFixture(store(services), services.db, {
        "terms-of-service": "v1",
        "privacy-policy": "v3",
      }),
    );

    const { status } = await register(services, {
      registrationConsent: { resolution: mint([TERMS_V1, PRIVACY_V3]), affirmed: true },
    });

    expect(status).toBe(201);
    expect(recordedConsents(services)).toEqual([
      { policyKey: "terms-of-service", policyVersion: "v1" },
      { policyKey: "privacy-policy", policyVersion: "v3" },
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
