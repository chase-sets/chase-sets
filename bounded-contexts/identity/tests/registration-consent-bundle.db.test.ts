import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres/schema";
import { createId } from "@chase-sets/primitives/typed-ids";
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
  type SignedRegistrationConsentResolution,
} from "../features/consents/domain/registration-consent";
import {
  activateConsentPolicyForTest,
  deactivateConsentPolicyForTest,
  replaceConsentPolicyVersionForTest,
} from "../features/consents/domain/consent-bundle-test-support";
import {
  deriveRegistrationOperation,
  REGISTRATION_OPERATION_CLAIMED_EVENT_TYPE,
  REGISTRATION_OPERATION_KEY_VERSION,
  type RegistrationOperationClaim,
} from "../support/runtime-support/registration-operation";
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

const TERMS_V1: RegistrationConsentRequirement = { policyKey: "terms-of-service", version: "v1", href: "/terms" };
const PRIVACY_V1: RegistrationConsentRequirement = { policyKey: "privacy-policy", version: "v1", href: "/privacy" };
const BUNDLE: readonly RegistrationConsentRequirement[] = [TERMS_V1, PRIVACY_V1];

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

  function composeServices(store: EventStore): IdentityServices {
    const deps = { eventStore: store, checkpointStore: createPostgresProjectionStore({ db: pool }), db: pool } as const;
    return {
      eventStore: store,
      db: pool,
      accounts: createAccountRuntime(deps),
      users: createUserRuntime(deps),
      memberships: createMembershipRuntime(deps),
      consents: createConsentRuntime(deps),
      projectors: [],
    } as unknown as IdentityServices;
  }

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ identity: pool });
    await pool.query(eventCorePostgresSchemaSql);
    await pool.query(identityAccountSchemaSql);
    eventStore = createPostgresEventStore({ pool });
    services = composeServices(eventStore);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  /**
   * Activation is per test rather than per suite: registration now revalidates
   * the WHOLE current bundle, so which members are active is part of what each
   * case asserts.
   */
  async function activate(requirements: readonly RegistrationConsentRequirement[]) {
    for (const requirement of requirements) {
      await activateConsentPolicyForTest(
        eventStore,
        requirement.policyKey as "privacy-policy" | "terms-of-service",
        requirement.version,
        operatorContext,
      );
    }
  }

  function mint(requirements: readonly RegistrationConsentRequirement[]): SignedRegistrationConsentResolution {
    return mintRegistrationConsentResolution({
      requirements,
      resolvedAt: new Date().toISOString(),
      signingKeys: resolveRegistrationConsentSigningKeys(),
    });
  }

  async function register(
    email: string,
    resolution: SignedRegistrationConsentResolution = mint(BUNDLE),
    affirmed = resolution.requirements.length > 0,
  ) {
    const response = await buildIdentityApi(services).request("/internal/auth/personal-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        displayName: "Bundle Registrant",
        registrationConsent: { resolution, affirmed },
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

  async function consentEventCount() {
    const recorded = await pool.query<{ policy_key: string }>(
      `SELECT payload ->> 'policyKey' AS policy_key FROM event_store_events
        WHERE event_type = 'identity.consent.recorded' ORDER BY global_position`,
    );
    return recorded.rows.map((row) => row.policy_key);
  }

  async function authorityStreamLength(activationPolicyKey: string) {
    const events = await eventStore.readStream({
      streamId: `platform-policy.consent-activation-authority-${activationPolicyKey}`,
    });
    return events.length;
  }

  async function expectNothingRegistered() {
    expect(await identityStreamIds("identity.account-")).toEqual([]);
    expect(await identityStreamIds("identity.user-")).toEqual([]);
    expect(await identityStreamIds("identity.membership-")).toEqual([]);
    expect(await identityStreamIds("identity.consent-")).toEqual([]);
    const reservations = await pool.query("SELECT display_name_key FROM identity_account_display_name_reservations");
    expect(reservations.rows).toEqual([]);
  }

  it("records the ordered affirmed bundle when every member is still activated", async () => {
    await activate(BUNDLE);

    const result = await register("bundle-ok@chasesets.test");

    expect(result.status).toBe(201);
    expect(await consentEventCount()).toEqual(["terms-of-service", "privacy-policy"]);
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
    await activate(BUNDLE);
    const resolution = mint(BUNDLE);
    await change();
    const authorityLengthBefore = await authorityStreamLength("identity.terms-of-service-active-version");

    const result = await register("bundle-raced@chasesets.test", resolution);

    expect(result.status).toBe(500);
    await expectNothingRegistered();
    expect(await authorityStreamLength("identity.terms-of-service-active-version")).toBe(authorityLengthBefore);
  });

  it("carries the activation guard into the registration transaction", async () => {
    // A guard moving between the plan's authority read and the commit must roll
    // the whole registration back. The move is injected inside `appendToStreams`,
    // strictly after the plan read the authority.
    await activate(BUNDLE);
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
    services = composeServices(racingEventStore);

    const result = await register("bundle-guarded@chasesets.test");

    expect(result.status).toBe(500);
    expect(await identityStreamIds("identity.consent-")).toEqual([]);
    expect(await identityStreamIds("identity.account-")).toEqual([]);
  });

  it("registers with an empty signed bundle while the current bundle is genuinely empty", async () => {
    // Nothing is activated, so the current requirement set really is empty and
    // the empty signed set still matches it exactly. Emptiness is a value: the
    // resolution still ran and still bound whatever it read.
    const response = await register("bundle-empty@chasesets.test", mint([]), false);

    expect(response.status).toBe(201);
    expect(await identityStreamIds("identity.consent-")).toEqual([]);
    expect((await identityStreamIds("identity.account-")).length).toBe(1);
  });

  it("still rejects a submission that is not server-minted", async () => {
    // #6105's transport contract is untouched: only the requirements array's
    // contents changed, and every rejection code still fires.
    await activate(BUNDLE);
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

  describe("a signed bundle is revalidated against the WHOLE current bundle", () => {
    it("rejects an empty signed bundle minted before a member was activated", async () => {
      // The exact #6290-F1 shape. The resolution is legitimately minted, signed,
      // fresh, and names nothing -- so there is nothing IN it to revalidate. A
      // member is activated afterwards, and the identity must not be created
      // without it.
      const resolution = mint([]);
      await activate([TERMS_V1]);

      const result = await register("bundle-stale-empty@chasesets.test", resolution, false);

      expect(result.status).toBe(500);
      await expectNothingRegistered();
      expect(await consentEventCount()).toEqual([]);
    });

    it("rejects a signed bundle missing a member activated after the mint", async () => {
      await activate([TERMS_V1]);
      const resolution = mint([TERMS_V1]);
      await activate([PRIVACY_V1]);

      const result = await register("bundle-grew@chasesets.test", resolution);

      expect(result.status).toBe(500);
      await expectNothingRegistered();
    });

    it("rolls the transaction back when a member is activated between re-resolution and append", async () => {
      // Terms of Service is active; the privacy policy is publication-ready but
      // has NEVER been activated, so the plan reads its authority, finds it
      // inactive, and carries that read's guard. The activation lands inside the
      // append. Without a guard on an omitted-but-readable member there is
      // nothing to conflict with and the registration would commit an identity
      // that is already missing a requirement.
      await activate([TERMS_V1]);
      const realAppendToStreams = eventStore.appendToStreams!;
      let moved = false;
      services = composeServices({
        ...eventStore,
        appendToStreams: async (inputs) => {
          if (!moved) {
            moved = true;
            await activateConsentPolicyForTest(eventStore, "privacy-policy", "v1", operatorContext);
          }
          return realAppendToStreams.call(eventStore, inputs);
        },
      });

      const result = await register("bundle-inactive-guard@chasesets.test", mint([TERMS_V1]));

      expect(result.status).toBe(500);
      await expectNothingRegistered();
    });
  });

  describe("an exact retry of a committed registration stays idempotent", () => {
    const EMAIL = "bundle-retry@chasesets.test";

    it("returns the prior identity after the authority moves, with one consent stream per member", async () => {
      // The exact #6290-F3 shape: a registration that already succeeded is
      // retried with the same request and the same signed token after the
      // authority moved. Revalidating committed history against today's
      // activation state would turn a completed registration into a 500.
      await activate(BUNDLE);
      const resolution = mint(BUNDLE);

      const first = await register(EMAIL, resolution);
      expect(first.status).toBe(201);
      const consentStreams = await identityStreamIds("identity.consent-");
      expect(consentStreams).toHaveLength(2);

      await replaceConsentPolicyVersionForTest(eventStore, "terms-of-service", "v1", "v2", operatorContext);

      const retry = await register(EMAIL, resolution);

      expect(retry.status).toBe(201);
      expect(retry.body.accountId).toBe(first.body.accountId);
      expect(retry.body.userId).toBe(first.body.userId);
      expect(retry.body.membershipId).toBe(first.body.membershipId);
      expect(await identityStreamIds("identity.consent-")).toEqual(consentStreams);
      expect(await consentEventCount()).toEqual(["terms-of-service", "privacy-policy"]);
    });

    it("rejects a PARTIAL recovery carrying the same old token", async () => {
      // A claim exists and the account committed, but no Consent did. Completing
      // it would append `identity.consent.recorded` at a version that is no
      // longer active, so it must fail closed with nothing added.
      await activate(BUNDLE);
      const resolution = mint(BUNDLE);
      const operation = deriveRegistrationOperation({ email: EMAIL })!;
      const accountId = createId("acc");
      const claim: RegistrationOperationClaim = {
        operationKeyDigest: operation.keyDigest,
        operationKeyVersion: REGISTRATION_OPERATION_KEY_VERSION,
        contactType: "email",
        accountId: accountId as never,
        userId: createId("usr") as never,
        membershipId: createId("mbr") as never,
        displayName: "Bundle Registrant",
        displayNameKey: "bundle registrant",
        consents: BUNDLE.map((requirement) => ({
          consentId: createId("cns"),
          policyKey: requirement.policyKey,
          policyVersion: requirement.version,
        })) as never,
        claimedAt: new Date().toISOString(),
      };
      await eventStore.appendToStream({
        streamId: operation.streamId,
        expectedVersion: "no_stream",
        events: [{ eventType: REGISTRATION_OPERATION_CLAIMED_EVENT_TYPE, payload: claim as never }],
        context: operatorContext as EventStoreContext,
      });
      await eventStore.appendToStream({
        streamId: `identity.account-${accountId}`,
        expectedVersion: "no_stream",
        events: [
          {
            eventType: "identity.account.created",
            payload: { accountId, name: "", accountType: "personal", displayName: "Bundle Registrant" },
          },
        ],
        context: operatorContext as EventStoreContext,
      });
      await replaceConsentPolicyVersionForTest(eventStore, "terms-of-service", "v1", "v2", operatorContext);

      const recovered = await register(EMAIL, resolution);

      expect(recovered.status).toBe(500);
      expect(await identityStreamIds("identity.consent-")).toEqual([]);
      expect(await identityStreamIds("identity.user-")).toEqual([]);
      expect(await identityStreamIds("identity.membership-")).toEqual([]);
      expect(await consentEventCount()).toEqual([]);
    });

    it("rejects a FRESH submission carrying the same old token", async () => {
      await activate(BUNDLE);
      const resolution = mint(BUNDLE);
      await replaceConsentPolicyVersionForTest(eventStore, "terms-of-service", "v1", "v2", operatorContext);

      const result = await register("bundle-fresh-old-token@chasesets.test", resolution);

      expect(result.status).toBe(500);
      await expectNothingRegistered();
    });
  });
});
