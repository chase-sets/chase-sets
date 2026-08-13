import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, StoredEvent } from "@chase-sets/event-core/storage";
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
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { buildIdentityApi, createBootstrapContext } from "../api";
import { createAccountRuntime } from "../features/accounts/api/runtime";
import { createConsentRuntime } from "../features/consents/api/runtime";
import { createMembershipRuntime } from "../features/memberships/api/runtime";
import { createUserRuntime } from "../features/users/api/runtime";
import { identityAccountSchemaSql } from "../features/accounts/read-model/schema";
import {
  mintRegistrationConsentResolution,
  type RegistrationConsentRequirement,
} from "../features/consents/domain/registration-consent";
import { resolveRegistrationConsentSigningKeys } from "../support/runtime-support/registration-consent-signing";
import type { IdentityServices } from "../support/runtime-support/services";
import {
  activateRealConsentAuthority,
  activatedMembersFor,
  fixtureRegistrationConsentBundleResolver,
  recordingAuthorityReaderOver,
} from "./consent-activation-authority-fixtures";

// Exercised against a real Postgres sandbox, never mocked: transaction
// rollback, expected-version enforcement and uniqueness are exactly the
// behaviours this suite is not allowed to reason about without executing them.
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

/**
 * The multi-member bundle these cases register against.
 *
 * It is exactly the `registration` bundle's declared members, in declared
 * order, because an append-producing attempt now has to agree with what the
 * current bundle derives -- a submission naming a policy the bundle does not
 * declare is superseded rather than recorded, which is a different case from
 * the ones here. The corresponding fixture publications and real authority
 * activations are set up per test, so this drives the identical production path
 * with a genuinely multi-member ordered bundle.
 */
const BUNDLE: readonly RegistrationConsentRequirement[] = [
  { policyKey: "terms-of-service", version: "v1", href: "/terms" },
  { policyKey: "privacy-policy", version: "v3", href: "/privacy" },
];

/**
 * Where a registration is made to fail. Each name is the participant whose
 * write throws; every participant ordered before it has already been attempted,
 * so "consent-2" is a failure injected after the first Consent was written.
 */
type InjectionPosition = "account" | "user" | "membership" | "consent-1" | "consent-2" | "outcome-fact";

type FaultControl = { position: InjectionPosition | null };

function participantOf(streamId: string, consentOrdinal: (streamId: string) => number): InjectionPosition | null {
  if (streamId.startsWith("identity.account-")) return "account";
  if (streamId.startsWith("identity.user-")) return "user";
  if (streamId.startsWith("identity.membership-")) return "membership";
  if (streamId.startsWith("identity.csat-outcome-fact-")) return "outcome-fact";
  if (!streamId.startsWith("identity.consent-")) return null;

  const ordinal = consentOrdinal(streamId);
  return ordinal >= 1 && ordinal <= BUNDLE.length ? (`consent-${ordinal}` as InjectionPosition) : null;
}

/**
 * Fails the store at one named participant, whatever shape the composition
 * writes in.
 *
 * Against a sequential composition each participant is its own `appendToStream`
 * call and only that call throws, so every earlier participant has already
 * committed. Against a single all-or-nothing `appendToStreams` batch the same
 * named participant is a member of the batch, and failing it must therefore
 * fail every participant with it. That difference is exactly what this suite
 * measures, so both entry points honour the same injection.
 */
function faultInjectingEventStore(inner: EventStore, fault: FaultControl): EventStore {
  // Only Consent streams take an ordinal, and each keeps the first position it
  // was seen at, so "consent-2" names the same member of the ordered bundle
  // whether the composition writes it as its own append or as one participant
  // of a shared batch.
  const consentOrder: string[] = [];
  const consentOrdinal = (streamId: string) => {
    if (!streamId.startsWith("identity.consent-")) {
      return 0;
    }
    if (!consentOrder.includes(streamId)) {
      consentOrder.push(streamId);
    }
    return consentOrder.indexOf(streamId) + 1;
  };
  const injected = (position: InjectionPosition) =>
    Object.assign(new Error(`Injected registration failure at ${position}.`), { code: "infrastructure_failure" });

  return {
    ...inner,
    appendToStream: async (input: AppendToStreamInput) => {
      const position = participantOf(input.streamId, consentOrdinal);
      if (position && position === fault.position) {
        throw injected(position);
      }
      return inner.appendToStream(input);
    },
    appendToStreams: inner.appendToStreams
      ? async (inputs: readonly AppendToStreamInput[]) => {
          for (const input of inputs) {
            consentOrdinal(input.streamId);
          }
          for (const input of inputs) {
            const position = participantOf(input.streamId, consentOrdinal);
            if (position && position === fault.position) {
              throw injected(position);
            }
          }
          return inner.appendToStreams!(inputs);
        }
      : undefined,
  };
}

type Harness = Readonly<{
  services: IdentityServices;
  fault: FaultControl;
  eventStore: EventStore;
}>;

describeDb("registration atomicity and convergence", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      contextNames,
      "identity_registration_atomicity",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.identity;
  });

  beforeEach(async () => {
    await resetIdentitySchema();
    await activateBundleAuthorities();
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  async function resetIdentitySchema() {
    await resetMultiContextTestSchemas({ identity: pool });
    await pool.query(eventCorePostgresSchemaSql);
    await pool.query(identityAccountSchemaSql);
  }

  function createServices(eventStore: EventStore): IdentityServices {
    const deps = {
      eventStore,
      checkpointStore: createPostgresProjectionStore({ db: pool }),
      db: pool,
    } as const;

    // Real Consent Activation Authority, fixture publications. The guards this
    // seam retains are revisions PostgreSQL actually holds, so a rolled-back
    // batch rolls back a genuinely guarded transaction.
    const policies = createPolicyRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    const registrationConsentBundles = fixtureRegistrationConsentBundleResolver(activatedMembersFor(BUNDLE), {
      authority: recordingAuthorityReaderOver(policies.consentActivation),
    });

    const services = {
      eventStore,
      db: pool,
      accounts: createAccountRuntime(deps),
      users: createUserRuntime(deps),
      memberships: createMembershipRuntime(deps),
      consents: createConsentRuntime(deps),
      registrationConsentBundles,
      policies,
      projectors: [],
    } as unknown as IdentityServices;

    return services;
  }

  function createHarness(): Harness {
    const fault: FaultControl = { position: null };
    const eventStore = faultInjectingEventStore(createPostgresEventStore({ pool }), fault);
    return { services: createServices(eventStore), fault, eventStore };
  }

  /**
   * Activate the whole bundle on the real authority. Written through an
   * uninjected store so the fault harness never sees the activation appends --
   * the injection names registration participants, not policy activation.
   */
  async function activateBundleAuthorities() {
    const policies = createPolicyRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    for (const member of activatedMembersFor(BUNDLE)) {
      await activateRealConsentAuthority(policies.consentActivation, createBootstrapContext(), member);
    }
  }

  function safeJson(text: string): Record<string, unknown> {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { raw: text };
    }
  }

  async function register(
    harness: Harness,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<{ status: number; body: Record<string, unknown> }>> {
    const response = await buildIdentityApi(harness.services).request("/internal/auth/personal-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner@pokebash.example",
        displayName: "PokeBash TCG",
        registrationConsent: {
          resolution: mintRegistrationConsentResolution({
            requirements: BUNDLE,
            resolvedAt: new Date().toISOString(),
            signingKeys: resolveRegistrationConsentSigningKeys(),
          }),
          affirmed: true,
        },
        ...body,
      }),
    });

    const text = await response.text();
    return { status: response.status, body: text ? safeJson(text) : {} };
  }

  async function postState(harness: Harness) {
    const events = await harness.eventStore.readAll({ limit: 500 });
    const streamsWithPrefix = (prefix: string) => [
      ...new Set(events.filter((event: StoredEvent) => event.streamId.startsWith(prefix)).map((e) => e.streamId)),
    ];
    const reservations = await pool.query<{ display_name_key: string; account_id: string }>(
      "SELECT display_name_key, account_id FROM identity_account_display_name_reservations ORDER BY display_name_key",
    );

    return {
      accounts: streamsWithPrefix("identity.account-"),
      users: streamsWithPrefix("identity.user-"),
      memberships: streamsWithPrefix("identity.membership-"),
      consents: streamsWithPrefix("identity.consent-"),
      reservations: reservations.rows,
    };
  }

  const positions: readonly InjectionPosition[] = ["account", "user", "membership", "consent-1", "consent-2"];

  it.each(positions)("leaves nothing partial when the registration fails at %s", async (position) => {
    const harness = createHarness();
    harness.fault.position = position;

    const failed = await register(harness, {});

    expect(failed.status).toBe(500);
    const state = await postState(harness);
    expect(state.accounts, "no Account may survive a failed registration").toEqual([]);
    expect(state.users, "no User may survive a failed registration").toEqual([]);
    expect(state.memberships, "no Membership may survive a failed registration").toEqual([]);
    expect(state.consents, "no Consent may survive a failed registration").toEqual([]);
    expect(state.reservations, "no display-name reservation may be retained").toEqual([]);
  });

  it.each(positions)("converges on retry after a failure at %s, without a conflict", async (position) => {
    const harness = createHarness();
    harness.fault.position = position;
    const failed = await register(harness, {});
    expect(failed.status).toBe(500);

    harness.fault.position = null;
    const retried = await register(harness, {});

    expect(retried.status, "the same operation must not be told the display name is taken").toBe(201);
    const state = await postState(harness);
    expect(state.accounts).toHaveLength(1);
    expect(state.users).toHaveLength(1);
    expect(state.memberships).toHaveLength(1);
    expect(state.consents).toHaveLength(BUNDLE.length);
    expect(state.reservations).toEqual([
      { display_name_key: "pokebash tcg", account_id: retried.body.accountId as string },
    ]);
  });

  it("rolls back earlier participants when a late Consent moves inside the real PostgreSQL append", async () => {
    const inner = createPostgresEventStore({ pool });
    let realAppendAttempted = false;
    let lateStreamId = "";
    let earlierStreamIds: readonly string[] = [];
    const eventStore: EventStore = {
      ...inner,
      appendToStreams: async (inputs) => {
        const lateConsent = [...inputs]
          .reverse()
          .find((input) => input.streamId.startsWith("identity.consent-") && input.events.length > 0);
        if (!lateConsent) {
          throw new Error("The registration batch must include a late Consent participant.");
        }
        const lateEvent = lateConsent.events[0];
        if (!lateEvent) {
          throw new Error("The late Consent participant must carry its recording event.");
        }
        lateStreamId = lateConsent.streamId;
        // Only the participants that carry events roll back to empty. The
        // batch also carries zero-event version guards -- including one per
        // Consent Activation Authority the bundle resolution read -- and those
        // streams hold the activation history the guard is checked against, so
        // asserting they end up empty would assert the authority was erased.
        earlierStreamIds = inputs
          .filter((input) => input.streamId !== lateConsent.streamId && input.events.length > 0)
          .map((input) => input.streamId);

        await inner.appendToStream({
          ...lateConsent,
          expectedVersion: "no_stream",
          events: [lateEvent],
        });

        try {
          realAppendAttempted = true;
          return await inner.appendToStreams!(inputs);
        } catch {
          throw Object.assign(new Error("Injected late-participant version conflict."), {
            code: "infrastructure_failure",
          });
        }
      },
    };
    const harness: Harness = {
      services: createServices(eventStore),
      fault: { position: null },
      eventStore,
    };

    const failed = await register(harness, {});

    expect(failed.status).toBe(500);
    expect(realAppendAttempted, "the real PostgreSQL multi-stream append must execute").toBe(true);
    expect(await inner.readStream({ streamId: lateStreamId })).toHaveLength(1);
    for (const streamId of earlierStreamIds) {
      expect(
        await inner.readStream({ streamId }),
        `${streamId} must roll back after the late expected-version conflict`,
      ).toEqual([]);
    }
    expect((await postState(harness)).reservations).toEqual([]);
  });

  it("converges when the same operation is registered again after success", async () => {
    const harness = createHarness();

    const first = await register(harness, {});
    const second = await register(harness, {});

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.accountId).toBe(first.body.accountId);
    expect(second.body.userId).toBe(first.body.userId);
    expect(second.body.membershipId).toBe(first.body.membershipId);

    const state = await postState(harness);
    expect(state.accounts).toHaveLength(1);
    expect(state.users).toHaveLength(1);
    expect(state.memberships).toHaveLength(1);
    expect(state.consents).toHaveLength(BUNDLE.length);
  });

  const CONCURRENT_ITERATIONS = 10;

  it(`settles concurrent same-operation registrations on one account across ${CONCURRENT_ITERATIONS} iterations`, async () => {
    for (let iteration = 1; iteration <= CONCURRENT_ITERATIONS; iteration += 1) {
      await resetIdentitySchema();
      await activateBundleAuthorities();
      const harness = createHarness();

      const [left, right] = await Promise.all([register(harness, {}), register(harness, {})]);

      expect(left.status, `iteration ${iteration}`).toBe(201);
      expect(right.status, `iteration ${iteration}`).toBe(201);
      expect(right.body.accountId, `iteration ${iteration}`).toBe(left.body.accountId);
      expect(right.body.userId, `iteration ${iteration}`).toBe(left.body.userId);
      expect(right.body.membershipId, `iteration ${iteration}`).toBe(left.body.membershipId);

      const state = await postState(harness);
      expect(state.accounts, `iteration ${iteration}`).toHaveLength(1);
      expect(state.users, `iteration ${iteration}`).toHaveLength(1);
      expect(state.memberships, `iteration ${iteration}`).toHaveLength(1);
      expect(state.consents, `iteration ${iteration}`).toHaveLength(BUNDLE.length);
      expect(state.reservations, `iteration ${iteration}`).toEqual([
        { display_name_key: "pokebash tcg", account_id: left.body.accountId as string },
      ]);
    }
  });

  it("leaves no reservation behind when concurrent attempts propose different display names", async () => {
    const harness = createHarness();

    // Same contact, so the same operation -- but two callers derived different
    // display names for it. Exactly one wins; the loser adopts the winner's
    // account and must not keep holding the name it proposed.
    const [left, right] = await Promise.all([
      register(harness, { displayName: "PokeBash TCG" }),
      register(harness, { displayName: "PokeBash Trading" }),
    ]);

    expect(left.status).toBe(201);
    expect(right.status).toBe(201);
    expect(right.body.accountId).toBe(left.body.accountId);

    const state = await postState(harness);
    expect(state.accounts).toHaveLength(1);
    expect(state.reservations, "the losing attempt's display name must be released").toHaveLength(1);
    expect(state.reservations[0].account_id).toBe(left.body.accountId);

    // The name the loser proposed is free for an unrelated registration.
    const other = await register(harness, {
      email: "other@pokebash.example",
      displayName: state.reservations[0].display_name_key === "pokebash tcg" ? "PokeBash Trading" : "PokeBash TCG",
    });
    expect(other.status).toBe(201);
  });

  it("keeps registrations for different contacts fully independent", async () => {
    const harness = createHarness();

    const first = await register(harness, { email: "one@pokebash.example", displayName: "PokeBash One" });
    const second = await register(harness, { email: "two@pokebash.example", displayName: "PokeBash Two" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.accountId).not.toBe(first.body.accountId);

    const state = await postState(harness);
    expect(state.accounts).toHaveLength(2);
    expect(state.users).toHaveLength(2);
    expect(state.memberships).toHaveLength(2);
    expect(state.consents).toHaveLength(BUNDLE.length * 2);
  });

  it("still rejects a display-name collision between different operations", async () => {
    const harness = createHarness();

    const holder = await register(harness, { email: "holder@pokebash.example", displayName: "PokeBash TCG" });
    const collider = await register(harness, { email: "collider@pokebash.example", displayName: "PokeBash TCG" });

    expect(holder.status).toBe(201);
    expect(collider.status).toBe(409);
    expect((collider.body.error as { code?: string } | undefined)?.code).toBe("display_name_already_taken");

    const state = await postState(harness);
    expect(state.accounts).toHaveLength(1);
    expect(state.users).toHaveLength(1);
  });

  it("does not let a failing cross-context outcome fact fail a committed registration", async () => {
    const harness = createHarness();
    harness.fault.position = "outcome-fact";

    const registered = await register(harness, {});

    expect(registered.status, "a committed registration must not be reported as failed").toBe(201);
    const state = await postState(harness);
    expect(state.accounts).toHaveLength(1);
    expect(state.users).toHaveLength(1);
    expect(state.memberships).toHaveLength(1);
    expect(state.consents).toHaveLength(BUNDLE.length);
  });

  it("registers a phone-only contact and enables its sms-code auth method atomically", async () => {
    const harness = createHarness();

    const registered = await register(harness, {
      email: null,
      phone: "+15555550123",
      displayName: "PokeBash Phone",
    });

    expect(registered.status).toBe(201);
    const state = await postState(harness);
    expect(state.users).toHaveLength(1);

    const userEvents = await harness.eventStore.readStream({ streamId: state.users[0] });
    expect(userEvents.map((event) => event.eventType)).toEqual([
      "identity.user.created",
      "identity.user.auth-method-enabled",
    ]);
  });

  it("opens the founders window inside the same atom as the account it belongs to", async () => {
    const harness = createHarness();
    harness.fault.position = "user";

    const failed = await register(harness, { foundersBetaAccessStartedAt: "2026-07-01T00:00:00.000Z" });
    expect(failed.status).toBe(500);
    expect((await postState(harness)).accounts, "the second account event must roll back with the first").toEqual([]);

    harness.fault.position = null;
    const retried = await register(harness, { foundersBetaAccessStartedAt: "2026-07-01T00:00:00.000Z" });
    expect(retried.status).toBe(201);

    const state = await postState(harness);
    const accountEvents = await harness.eventStore.readStream({ streamId: state.accounts[0] });
    expect(accountEvents.map((event) => event.eventType)).toEqual([
      "identity.account.created",
      "identity.account.founders-window-opened",
    ]);
  });
});
