import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as identityModule } from "../index";
import { createIdentityServices, type IdentityServices } from "../support/runtime-support/services";
import { DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY } from "../features/account-capabilities/api/authority";
import { activeRegistrationConsentFixture } from "./consent-activation-authority-fixtures";
import { createIdentityBootstrapContext } from "../support/runtime-support/bootstrap-context";
import { identityConsentActiveVersionPolicies } from "../features/consents/domain/terms-of-service-policy";
import * as consentBundle from "../features/consents/domain/consent-bundle";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for registration constructor database tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("registration Consent constructor against an isolated active publication fixture", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>>;
  let services: IdentityServices;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["identity"], "identity_constructor_active");
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

  it("recovers dormant -> active -> dormant across fresh constructor instances", async () => {
    const dormant = await services.registrationConsentBundles.resolve();
    expect(dormant.requirements).toEqual([]);

    const fixture = await activeRegistrationConsentFixture(services.eventStore!, pools.identity, {
      "terms-of-service": "v1",
      "privacy-policy": "v3",
    });
    const publications = fixture.publications;
    vi.spyOn(consentBundle, "resolveConsentBundle").mockImplementation((authority, bundleKey) =>
      consentBundle.resolveConsentBundleAgainstCorpus(authority, bundleKey, publications),
    );

    const activeServices = createIdentityServices(pools.identity, {
      capabilityAdministrationAuthority: DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY,
    });
    const activeRead = vi.spyOn(activeServices.policies.consentActivation, "read");
    const active = await activeServices.registrationConsentBundles.resolve();
    expect(active.requirements).toEqual([
      { policyKey: "terms-of-service", version: "v1", href: "/terms" },
      { policyKey: "privacy-policy", version: "v3", href: "/privacy" },
    ]);
    expect(active.guards).toHaveLength(2);
    expect(activeRead).toHaveBeenCalledTimes(2);

    const context = createIdentityBootstrapContext();
    for (const policyKey of ["terms-of-service", "privacy-policy"] as const) {
      await fixture.policies.consentActivation.deactivate(
        identityConsentActiveVersionPolicies[policyKey],
        { actorUserId: "usr_constructor_operator" },
        context,
      );
    }

    const recoveredServices = createIdentityServices(pools.identity, {
      capabilityAdministrationAuthority: DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY,
    });
    const recovered = await recoveredServices.registrationConsentBundles.resolve();
    expect(recovered.requirements).toEqual([]);
    expect(recovered.guards).toHaveLength(2);
    expect(recovered.outcomes.map((outcome) => outcome.kind)).toEqual(["omitted-inactive", "omitted-inactive"]);
  });

  it("does not admit a publication override through the host-port bag", async () => {
    const fixture = await activeRegistrationConsentFixture(services.eventStore!, pools.identity, {
      "terms-of-service": "v1",
      "privacy-policy": "v3",
    });
    const override = {
      capabilityAdministrationAuthority: DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY,
      publications: fixture.publications,
    } as never;
    const overridden = createIdentityServices(pools.identity, override);
    const declaration = await overridden.registrationConsentBundles.resolve();
    expect(declaration.requirements).toEqual([]);
    expect(declaration.outcomes.every((outcome) => outcome.kind === "publication-ineligible")).toBe(true);
  });
});
