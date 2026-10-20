import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
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

it("keeps the registration endpoint-invoker census explicit and fail-closed", () => {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const registrationEndpoints = ["/internal/auth/" + "personal-identities", "/internal/auth/" + "registration-consent"];
  const expected = new Map([
    ["bounded-contexts/identity/tests/api-mutation-snapshots.test.ts", "RegistrationConsentBundles fixture"],
    ["bounded-contexts/identity/tests/internal-auth-routes.test.ts", "RegistrationConsentBundles fixture"],
    [
      "bounded-contexts/identity/tests/registration-atomicity.db.test.ts",
      "constructor + resolveConsentBundle publication spy",
    ],
    ["bounded-contexts/identity/tests/registration-consent-boundary.test.ts", "RegistrationConsentBundles fixture"],
    [
      "bounded-contexts/identity/tests/registration-operation-recovery.db.test.ts",
      "constructor + resolveConsentBundle publication spy",
    ],
    [
      "bounded-contexts/identity/tests/registration-operation-validation.db.test.ts",
      "constructor + resolveConsentBundle publication spy",
    ],
    ["bounded-contexts/identity/tests/registration-active-bundle-constructor-dormant.db.test.ts", "real constructor"],
    [
      "bounded-contexts/identity/tests/registration-active-bundle-constructor.db.test.ts",
      "constructor + resolveConsentBundle publication spy",
    ],
    [
      "bounded-contexts/identity/features/account-management/api/account-management.db.test.ts",
      "RegistrationConsentBundles fixture",
    ],
  ] as const);
  const tracked = execFileSync("git", ["ls-files", "--", "bounded-contexts/identity/**/*.test.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean);
  const sources = new Map(
    tracked.map((relativePath) => [relativePath, readFileSync(resolvePath(repoRoot, relativePath), "utf8")]),
  );
  const deriveInvokers = (files: ReadonlyMap<string, string>) =>
    [...files]
      .filter(([relativePath, source]) => {
        const explicitlyAdded =
          relativePath.endsWith("registration-active-bundle-constructor.db.test.ts") ||
          relativePath.endsWith("registration-active-bundle-constructor-dormant.db.test.ts");
        return (
          registrationEndpoints.some((endpoint) => source.includes(endpoint)) ||
          explicitlyAdded ||
          (source.includes("registrationConsentBundles") &&
            (source.includes("buildIdentityApi") || source.includes("createIdentityServices")))
        );
      })
      .map(([relativePath]) => relativePath);
  const invoking = deriveInvokers(sources);

  expect(new Set(invoking)).toEqual(new Set(expected.keys()));
  const unexpected = new Map(sources);
  unexpected.set("bounded-contexts/identity/tests/synthetic-unexpected-invoker.test.ts", registrationEndpoints[0]);
  expect(() => expect(new Set(deriveInvokers(unexpected))).toEqual(new Set(expected.keys()))).toThrow();
  const missing = new Map(expected);
  missing.delete("bounded-contexts/identity/tests/registration-atomicity.db.test.ts");
  expect(() => expect(new Set(invoking)).toEqual(new Set(missing.keys()))).toThrow();
  for (const [relativePath, seam] of expected) {
    expect(tracked, `${relativePath} must remain tracked`).toContain(relativePath);
    const source = readFileSync(resolvePath(repoRoot, relativePath), "utf8");
    if (seam.startsWith("constructor") || seam === "real constructor")
      expect(source).toContain("createIdentityServices");
    if (seam === "constructor + resolveConsentBundle publication spy")
      expect(source).toContain('"resolveConsentBundle"');
    if (seam === "RegistrationConsentBundles fixture")
      expect(source).toMatch(/registrationConsentBundlesFixture|activeRegistrationConsentFixture/);
  }
});
