import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres/schema";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { buildIdentityApi } from "../api";
import { identityAccountSchemaSql } from "../features/accounts/read-model/schema";
import { publicPolicyPublicationRecords } from "@chase-sets/public-docs";
import {
  REGISTRATION_CONSENT_ACTIVATABLE_POLICIES,
  type SignedRegistrationConsentResolution,
} from "../features/consents/domain/registration-consent";
import { createIdentityServices } from "../support/runtime-support/services";

/**
 * The UNMOCKED production constructor against the shipped corpus.
 *
 * Deliberately its own module, with no `vi.mock` anywhere in it, because the
 * active proof mocks the publication corpus at module scope and a shared file
 * would leave "dormant" describing whatever the other suite installed. This is
 * the state production is actually in: every published policy compiles as not
 * consent-activatable, so the bundle resolves to no requirements at all -- and
 * it resolves, rather than being skipped.
 */

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

describeDb("registration consent bundle constructor (dormant corpus)", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      contextNames,
      "identity_bundle_constructor_dormant",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.identity;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ identity: pool });
    await pool.query(eventCorePostgresSchemaSql);
    await pool.query(identityAccountSchemaSql);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  it("binds the registration bundle seam unconditionally, with no port to override it", () => {
    // Both call shapes the composition root supports. Neither takes a bundle
    // argument, so there is no expression a host can write that composes an
    // Identity whose registration consent comes from somewhere else.
    const withoutPorts = createIdentityServices(pool);
    const withPorts = createIdentityServices(pool, { addressVerificationProvider: null });

    expect(typeof withoutPorts.registrationConsentBundles.resolve).toBe("function");
    expect(typeof withPorts.registrationConsentBundles.resolve).toBe("function");
    expect(withPorts.registrationConsentBundles, "a host port must not be able to substitute the resolver").not.toBe(
      withoutPorts.registrationConsentBundles,
    );
  });

  it("resolves the shipped corpus to an empty requirement list without reading any authority", async () => {
    const services = createIdentityServices(pool);

    const resolution = await services.registrationConsentBundles.resolve();

    expect(resolution.resolved).toBe(true);
    expect(resolution.resolved && resolution.requirements).toEqual([]);
    // Every declared member is publication-ineligible, so no authority read was
    // warranted and no guard exists to retain. Emptiness here is a derived
    // value, not a disabled mode.
    expect(resolution.guards).toEqual([]);
    expect(Object.values(publicPolicyPublicationRecords).every((record) => !record.consentActivatable)).toBe(true);
    expect(REGISTRATION_CONSENT_ACTIVATABLE_POLICIES).toEqual([]);
  });

  it("mints a signed, version-bearing resolution over the empty derived bundle", async () => {
    const services = createIdentityServices(pool);

    const response = await buildIdentityApi(services).request("/internal/auth/registration-consent");

    expect(response.status).toBe(200);
    const minted = (await response.json()) as SignedRegistrationConsentResolution;
    expect(minted.bundleKey).toBe("registration");
    expect(minted.requirements).toEqual([]);
    expect(minted.signature.length).toBeGreaterThan(0);
  });
});
