import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres/schema";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { buildIdentityApi, createBootstrapContext } from "../api";
import { identityAccountSchemaSql } from "../features/accounts/read-model/schema";
import {
  mintRegistrationConsentResolution,
  type SignedRegistrationConsentResolution,
} from "../features/consents/domain/registration-consent";
import { identityConsentActiveVersionPolicyFor } from "../features/consents/domain/terms-of-service-policy";
import { resolveRegistrationConsentSigningKeys } from "../support/runtime-support/registration-consent-signing";
import { createIdentityServices } from "../support/runtime-support/services";

/**
 * The REAL production constructor with ONE thing isolated: the compiled
 * publication corpus.
 *
 * `createIdentityServices` is called unmodified, so the resolver under test is
 * the one production binds, wired to the real Consent Activation Authority in a
 * real database. Only Public Presence's compiled metadata is substituted --
 * which is the single fact that has not landed yet, and the only reason the
 * shipped constructor is dormant. Everything about derivation, guard retention
 * and admission is production code executing against PostgreSQL.
 */
vi.mock("@chase-sets/public-docs", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/public-docs")>("@chase-sets/public-docs");
  return {
    ...actual,
    publicPolicyPublicationRecords: {
      ...actual.publicPolicyPublicationRecords,
      "terms-of-service": {
        ...actual.publicPolicyPublicationRecords["terms-of-service"],
        version: "v4",
        publicationStatus: "published" as const,
        effectiveAt: "2026-07-01T00:00:00.000Z",
        counselApprovalReference: "counsel-fixture-1",
        consentActivatable: true,
      },
    },
  };
});

const TERMS_VERSION = "v4";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["identity"] as const;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for database-backed tests.");
  }
  return databaseBaseUrl;
}

describeDb("registration consent bundle constructor (active member)", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;
  let services: ReturnType<typeof createIdentityServices>;
  const context = createBootstrapContext();

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      contextNames,
      "identity_bundle_constructor_active",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.identity;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ identity: pool });
    await pool.query(eventCorePostgresSchemaSql);
    await pool.query(identityAccountSchemaSql);
    services = createIdentityServices(pool);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  /** Consent facts read from the command side; no projection runs in this suite. */
  async function recordedConsents() {
    const events = (await services.eventStore?.readAll({ limit: 500 })) ?? [];
    return events
      .filter((event) => event.streamId.startsWith("identity.consent-"))
      .map((event) => event.payload as unknown as { policyKey: string; policyVersion: string })
      .map((payload) => ({ policyKey: payload.policyKey, policyVersion: payload.policyVersion }));
  }

  async function activateTerms(version = TERMS_VERSION) {
    const definition = identityConsentActiveVersionPolicyFor("terms-of-service");
    await services.policies.consentActivation.register(definition, context);
    await services.policies.consentActivation.activate(
      definition,
      { version, documentId: `pol_terms_${version}`, actorUserId: "usr_operator" },
      context,
    );
  }

  it("retains a guard but derives no requirement while a publication-ready member is inactive", async () => {
    const resolution = await services.registrationConsentBundles.resolve();

    expect(resolution.resolved).toBe(true);
    expect(resolution.resolved && resolution.requirements).toEqual([]);
    // "Publication-ready but inactive when read" is a fact a later append has
    // to be able to guard against, so the guard is retained even though the
    // member contributes no requirement.
    expect(resolution.guards.map((binding) => binding.policyKey)).toEqual(["terms-of-service"]);
  });

  it("derives the requirement from one real authority read once the key is activated", async () => {
    await activateTerms();

    const resolution = await services.registrationConsentBundles.resolve();

    expect(resolution.resolved && resolution.requirements).toEqual([
      { policyKey: "terms-of-service", version: TERMS_VERSION, href: "/terms" },
    ]);
    expect(resolution.guards).toHaveLength(1);
  });

  it("mints the derived requirement and admits a registration that submits it", async () => {
    await activateTerms();
    const app = buildIdentityApi(services);

    const minted = (await (
      await app.request("/internal/auth/registration-consent")
    ).json()) as SignedRegistrationConsentResolution;
    expect(minted.requirements).toEqual([{ policyKey: "terms-of-service", version: TERMS_VERSION, href: "/terms" }]);

    const registered = await app.request("/internal/auth/personal-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner@pokebash.example",
        displayName: "PokeBash TCG",
        registrationConsent: { resolution: minted, affirmed: true },
      }),
    });

    expect(registered.status).toBe(201);
    const recorded = await recordedConsents();
    expect(recorded).toEqual([{ policyKey: "terms-of-service", policyVersion: TERMS_VERSION }]);
  });

  it("refuses a submission the authority has since replaced, appending nothing", async () => {
    await activateTerms();
    const stale = mintRegistrationConsentResolution({
      requirements: [{ policyKey: "terms-of-service", version: "v3", href: "/terms" }],
      resolvedAt: new Date().toISOString(),
      signingKeys: resolveRegistrationConsentSigningKeys(),
    });

    const response = await buildIdentityApi(services).request("/internal/auth/personal-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "stale@pokebash.example",
        displayName: "Stale Submitter",
        registrationConsent: { resolution: stale, affirmed: true },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "registration_consent_expired", reason: "superseded" },
    });
    expect(await recordedConsents()).toEqual([]);
  });
});
