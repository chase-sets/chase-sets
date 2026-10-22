import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { mintRegistrationConsentResolution } from "../features/consents/domain/registration-consent";
import { buildIdentityApi } from "../api";
import { module as identityModule } from "../index";
import { createIdentityServices, type IdentityServices } from "../support/runtime-support/services";
import { DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY } from "../features/account-capabilities/api/authority";
import { resolveRegistrationConsentSigningKeys } from "../support/runtime-support/registration-consent-signing";
import * as consentBundle from "../features/consents/domain/consent-bundle";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for registration constructor database tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("registration Consent constructor against canonical dormant publications", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>>;
  let services: IdentityServices;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["identity"], "identity_constructor_dormant");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.identity.query(identityModule.schemaSql);
    services = createIdentityServices(pools.identity, {
      capabilityAdministrationAuthority: DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY,
    });
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  afterEach(() => vi.restoreAllMocks());

  it("constructs an empty dormant declaration and retains no authority cache", async () => {
    const authorityRead = vi.spyOn(services.policies.consentActivation, "read");

    const declaration = await services.registrationConsentBundles.resolve();
    expect(declaration).toMatchObject({
      bundleKey: "registration",
      subjectScope: "user",
      resolved: true,
      requirements: [],
      guards: [],
    });
    expect(declaration.outcomes).toEqual([
      { kind: "publication-ineligible", policyKey: "terms-of-service" },
      { kind: "publication-ineligible", policyKey: "privacy-policy" },
    ]);
    expect(authorityRead).not.toHaveBeenCalled();

    const bound = await services.registrationConsentBundles.forRegistration({
      userId: "usr_constructor_dormant",
      accountId: "acc_constructor_dormant",
    });
    expect(bound.subject).toEqual({
      userId: "usr_constructor_dormant",
      accountId: "acc_constructor_dormant",
    });
    expect(bound.declaration.requirements).toEqual([]);
    expect(bound.declaration).not.toBe(declaration);
  });

  it("uses the constructor seam for the endpoint instead of invoking a resolver directly", async () => {
    const bind = vi.spyOn(services.registrationConsentBundles, "forRegistration");
    const resolver = vi.spyOn(consentBundle, "resolveConsentBundle");
    const app = buildIdentityApi(services);
    const response = await app.request("/internal/auth/personal-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "constructor-dormant@example.test",
        displayName: "Constructor Dormant",
        registrationConsent: {
          resolution: mintRegistrationConsentResolution({
            requirements: [],
            resolvedAt: new Date().toISOString(),
            signingKeys: resolveRegistrationConsentSigningKeys(),
          }),
          affirmed: false,
        },
      }),
    });

    expect(response.status).toBe(201);
    expect(bind).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});
