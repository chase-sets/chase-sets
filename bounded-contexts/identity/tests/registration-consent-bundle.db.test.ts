import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres/schema";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { buildIdentityApi } from "../api";
import { createAccountRuntime } from "../features/accounts/api/runtime";
import { createConsentRuntime } from "../features/consents/api/runtime";
import { createMembershipRuntime } from "../features/memberships/api/runtime";
import { createUserRuntime } from "../features/users/api/runtime";
import { identityAccountSchemaSql } from "../features/accounts/read-model/schema";
import {
  mintRegistrationConsentResolution,
  type RegistrationConsentRequirement,
} from "../features/consents/domain/registration-consent";
import {
  activateConsentPolicyForTest,
  deactivateConsentPolicyForTest,
  replaceConsentPolicyVersionForTest,
} from "../features/consents/domain/consent-bundle-test-support";
import { resolveRegistrationConsentSigningKeys } from "../support/runtime-support/registration-consent-signing";
import type { IdentityServices } from "../support/runtime-support/services";

vi.mock("@chase-sets/public-docs", async (importOriginal) => {
  const { publicDocsWithConsentActivatable } =
    await import("../features/consents/domain/consent-publication-test-support");
  return publicDocsWithConsentActivatable(importOriginal, ["terms-of-service", "privacy-policy"]);
});

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for registration Consent Bundle database tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["identity"] as const;

const BUNDLE: readonly RegistrationConsentRequirement[] = [
  { policyKey: "terms-of-service", version: "v1", href: "/terms" },
  { policyKey: "privacy-policy", version: "v1", href: "/privacy" },
];

const operatorContext = {
  tenantId: "tnt_identity" as never,
  audit: { performedByUserId: "usr_policy_operator", forAccountId: "acc_policy_operator" },
  trace: {},
} as never;

describeDb("registration against the resolved Consent Bundle", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;
  let eventStore: EventStore;
  let services: IdentityServices;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "identity_registration_consent_bundle",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.identity;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ identity: pool });
    await pool.query(eventCorePostgresSchemaSql);
    await pool.query(identityAccountSchemaSql);
    eventStore = createPostgresEventStore({ pool });
    const deps = { eventStore, checkpointStore: createPostgresProjectionStore({ db: pool }), db: pool } as const;
    services = {
      eventStore,
      db: pool,
      accounts: createAccountRuntime(deps),
      users: createUserRuntime(deps),
      memberships: createMembershipRuntime(deps),
      consents: createConsentRuntime(deps),
      projectors: [],
    } as unknown as IdentityServices;

    for (const requirement of BUNDLE) {
      await activateConsentPolicyForTest(
        eventStore,
        requirement.policyKey as "privacy-policy" | "terms-of-service",
        requirement.version,
        operatorContext,
      );
    }
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  async function register(email: string) {
    const response = await buildIdentityApi(services).request("/internal/auth/personal-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        displayName: "Bundle Registrant",
        registrationConsent: {
          resolution: mintRegistrationConsentResolution({
            requirements: BUNDLE,
            resolvedAt: new Date().toISOString(),
            signingKeys: resolveRegistrationConsentSigningKeys(),
          }),
          affirmed: true,
        },
      }),
    });
    const text = await response.text();
    // A rejected registration returns the framework's plain-text 500 body, so
    // the body is parsed only when it is actually JSON.
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = { raw: text };
    }
    return { status: response.status, body };
  }

  async function identityStreamIds(prefix: string) {
    // 500 is the event store's maximum read page size.
    const events = await eventStore.readAll({ limit: 500, streamPrefixes: [prefix] });
    return [...new Set(events.map((event) => event.streamId))];
  }

  async function authorityStreamLength(activationPolicyKey: string) {
    const events = await eventStore.readStream({
      streamId: `platform-policy.consent-activation-authority-${activationPolicyKey}`,
    });
    return events.length;
  }

  it("records the ordered affirmed bundle when every member is still activated", async () => {
    const result = await register("bundle-ok@chasesets.test");

    expect(result.status).toBe(201);
    const recorded = await pool.query<{ payload: { policyKey: string; policyVersion: string } }>(
      `SELECT payload FROM event_store_events
        WHERE event_type = 'identity.consent.recorded'
        ORDER BY global_position`,
    );
    expect(recorded.rows.map((row) => row.payload.policyKey)).toEqual(["terms-of-service", "privacy-policy"]);
    expect(recorded.rows.map((row) => row.payload.policyVersion)).toEqual(["v1", "v1"]);
  });

  it.each([
    {
      name: "the active version is replaced mid-registration",
      change: async () => {
        await replaceConsentPolicyVersionForTest(eventStore, "terms-of-service", "v1", "v2", operatorContext);
      },
    },
    {
      name: "the authority is deactivated mid-registration",
      change: async () => {
        await deactivateConsentPolicyForTest(eventStore, "terms-of-service", "v1", operatorContext);
      },
    },
  ])("rejects an append when activation changes after the bundle is resolved: $name", async ({ change }) => {
    // The affirmed resolution is minted first, exactly as a client would hold
    // it, and the activation moves before the registration is submitted.
    await change();
    const authorityLengthBefore = await authorityStreamLength("identity.terms-of-service-active-version");

    const result = await register("bundle-raced@chasesets.test");

    expect(result.status).toBe(500);
    expect(await identityStreamIds("identity.account-")).toEqual([]);
    expect(await identityStreamIds("identity.user-")).toEqual([]);
    expect(await identityStreamIds("identity.membership-")).toEqual([]);
    expect(await identityStreamIds("identity.consent-")).toEqual([]);
    expect(await authorityStreamLength("identity.terms-of-service-active-version")).toBe(authorityLengthBefore);
    const reservations = await pool.query("SELECT display_name_key FROM identity_account_display_name_reservations");
    expect(reservations.rows).toEqual([]);
  });

  it("carries the activation guard into the registration transaction", async () => {
    // A guard moving between the plan's authority read and the commit must roll
    // the whole registration back. The move is injected inside `appendToStreams`,
    // strictly after the plan read the authority.
    const realAppendToStreams = eventStore.appendToStreams!;
    let moved = false;
    const racingEventStore: EventStore = {
      ...eventStore,
      appendToStreams: async (inputs) => {
        if (!moved) {
          moved = true;
          await replaceConsentPolicyVersionForTest(eventStore, "privacy-policy", "v1", "v2", operatorContext);
        }
        return realAppendToStreams.call(eventStore, inputs);
      },
    };
    const deps = {
      eventStore: racingEventStore,
      checkpointStore: createPostgresProjectionStore({ db: pool }),
      db: pool,
    } as const;
    services = {
      eventStore: racingEventStore,
      db: pool,
      accounts: createAccountRuntime(deps),
      users: createUserRuntime(deps),
      memberships: createMembershipRuntime(deps),
      consents: createConsentRuntime(deps),
      projectors: [],
    } as unknown as IdentityServices;

    const result = await register("bundle-guarded@chasesets.test");

    expect(result.status).toBe(500);
    expect(await identityStreamIds("identity.consent-")).toEqual([]);
    expect(await identityStreamIds("identity.account-")).toEqual([]);
  });

  it("mints an empty ordered requirement set against the shipped corpus and still signs it", async () => {
    // Unmocked corpus semantics: with nothing consent-activatable the mint is
    // still a signed, version-bearing, mandatory value. Proven here by minting
    // over an empty requirement list and registering with it.
    const response = await buildIdentityApi(services).request("/internal/auth/personal-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "bundle-empty@chasesets.test",
        displayName: "Empty Bundle Registrant",
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
    expect(await identityStreamIds("identity.consent-")).toEqual([]);
    expect((await identityStreamIds("identity.account-")).length).toBe(1);
  });

  it("still rejects a submission that is not server-minted", async () => {
    // #6105's transport contract is untouched: only the requirements array's
    // contents changed, and every rejection code still fires.
    const response = await buildIdentityApi(services).request("/internal/auth/personal-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "bundle-forged@chasesets.test",
        displayName: "Forged",
        registrationConsent: {
          resolution: { bundleKey: "registration", requirements: BUNDLE, resolvedAt: new Date().toISOString() },
          affirmed: true,
        },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "registration_consent_not_server_minted" },
    });
    expect(await identityStreamIds("identity.consent-")).toEqual([]);
  });
});
