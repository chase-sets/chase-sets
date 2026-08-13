import { describe, expect, it, vi } from "vitest";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import { consentActivationAuthorityStreamId } from "@chase-sets/platform-policy/consent-activation-authority";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import { buildIdentityApi, createBootstrapContext } from "../api";
import {
  mintRegistrationConsentResolution,
  REGISTRATION_CONSENT_EXPIRED_CODE,
  type RegistrationConsentRequirement,
} from "../features/consents/domain/registration-consent";
import { identityConsentActiveVersionPolicyFor } from "../features/consents/domain/terms-of-service-policy";
import { resolveRegistrationConsentSigningKeys } from "../support/runtime-support/registration-consent-signing";
import type { IdentityServices } from "../support/runtime-support/services";
import {
  fixtureBundleAuthorityReader,
  fixtureRegistrationConsentBundleResolver,
  type ActivatedConsentMember,
  type FixtureRegistrationConsentBundleResolver,
} from "./consent-activation-authority-fixtures";
import { createInMemoryEventStore, type InMemoryEventStore } from "./in-memory-event-store";

/**
 * Whole-bundle registration atomicity.
 *
 * Two members are required, so the append carries two authority guards
 * alongside the claim and the four aggregates. Everything below is asserted on
 * the batch that was actually committed through a store with real
 * expected-version enforcement: a guard that names a revision the stream does
 * not hold conflicts, and the all-or-nothing batch takes every participant with
 * it.
 */

const TERMS_V1: RegistrationConsentRequirement = { policyKey: "terms-of-service", version: "v1", href: "/terms" };
const PRIVACY_V3: RegistrationConsentRequirement = { policyKey: "privacy-policy", version: "v3", href: "/privacy" };
const BUNDLE = [TERMS_V1, PRIVACY_V3] as const;
const MEMBERS: readonly ActivatedConsentMember[] = [
  { policyKey: "terms-of-service", version: "v1" },
  { policyKey: "privacy-policy", version: "v3" },
];

/** The revision `activeSnapshot` describes: one registration plus one activation. */
const ACTIVE_AUTHORITY_REVISION = 2;

function authorityStreamFor(policyKey: ActivatedConsentMember["policyKey"]): string {
  return consentActivationAuthorityStreamId(identityConsentActiveVersionPolicyFor(policyKey).policyKey);
}

const context: EventStoreContext = createBootstrapContext();

/**
 * Bring one authority stream to an explicit revision, so the guard the bundle
 * retained either matches it or does not. The events are placeholders: nothing
 * in this suite reads that stream back, and the guard is a version assertion.
 */
async function seedAuthorityRevision(
  store: InMemoryEventStore,
  policyKey: ActivatedConsentMember["policyKey"],
  revision: number,
): Promise<void> {
  if (revision === 0) {
    return;
  }
  await store.appendToStream({
    streamId: authorityStreamFor(policyKey),
    expectedVersion: "no_stream",
    events: Array.from({ length: revision }, () => ({
      eventType: "platform-policy.consent-activation-authority.registered",
      payload: {} as never,
    })),
    context,
  });
}

type Harness = Readonly<{
  services: IdentityServices;
  store: InMemoryEventStore;
  appendToStreams: ReturnType<typeof vi.fn>;
  bundles: FixtureRegistrationConsentBundleResolver;
}>;

function buildHarness(options: Readonly<{ bundles?: FixtureRegistrationConsentBundleResolver }> = {}): Harness {
  const store = createInMemoryEventStore();
  const appendToStreams = vi.fn(store.appendToStreams);
  const eventStore = { ...store, appendToStreams } as typeof store;
  const bundles = options.bundles ?? fixtureRegistrationConsentBundleResolver(MEMBERS);
  const services = {
    eventStore,
    db: {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("INSERT INTO identity_account_display_name_reservations")
          ? [{ display_name_key: "pokebash tcg" }]
          : [],
      })),
    },
    // The guest-checkout paths reach the per-aggregate command handlers rather
    // than the atomic registration composition, so they are stubbed here; what
    // this suite measures about them is what they do NOT touch.
    accounts: { commandHandler: vi.fn(async () => ({ version: 1, state: { status: "active" } })) },
    users: {
      getUserBySocialLogin: vi.fn(async () => null),
      commandHandler: vi.fn(async () => ({ version: 1, state: { status: "active" } })),
    },
    memberships: { commandHandler: vi.fn(async () => ({ version: 1, state: { status: "active" } })) },
    registrationConsentBundles: bundles,
    projectors: [],
  } as unknown as IdentityServices;

  return { services, store, appendToStreams, bundles };
}

async function register(
  harness: Harness,
  bundle: readonly RegistrationConsentRequirement[] = BUNDLE,
  body: Record<string, unknown> = {},
) {
  const app = buildIdentityApi(harness.services);
  app.onError(errorHandler);
  const response = await app.request("/internal/auth/personal-identities", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "owner@pokebash.example",
      displayName: "PokeBash TCG",
      registrationConsent: {
        resolution: mintRegistrationConsentResolution({
          requirements: bundle,
          resolvedAt: new Date().toISOString(),
          signingKeys: resolveRegistrationConsentSigningKeys(),
        }),
        affirmed: true,
      },
      ...body,
    }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function batchStreamIds(appendToStreams: Harness["appendToStreams"], call = 0): readonly string[] {
  const inputs = (appendToStreams.mock.calls[call]?.[0] ?? []) as readonly AppendToStreamInput[];
  return inputs.map((input) => input.streamId);
}

function identityStreams(store: InMemoryEventStore) {
  return [
    ...store.streamIdsWithPrefix("identity.account-"),
    ...store.streamIdsWithPrefix("identity.user-"),
    ...store.streamIdsWithPrefix("identity.membership-"),
    ...store.streamIdsWithPrefix("identity.consent-"),
    ...store.streamIdsWithPrefix("identity.registration-operation-"),
  ];
}

async function seedBothAuthorities(harness: Harness, revisions: Readonly<{ terms: number; privacy: number }>) {
  await seedAuthorityRevision(harness.store, "terms-of-service", revisions.terms);
  await seedAuthorityRevision(harness.store, "privacy-policy", revisions.privacy);
}

describe("AC5 whole-bundle registration atomicity", () => {
  it("carries one zero-event guard per resolved member in the existing atomic batch", async () => {
    const harness = buildHarness();
    await seedBothAuthorities(harness, {
      terms: ACTIVE_AUTHORITY_REVISION,
      privacy: ACTIVE_AUTHORITY_REVISION,
    });

    const registered = await register(harness);

    expect(registered.status).toBe(201);
    expect(harness.appendToStreams, "registration is still one transaction").toHaveBeenCalledTimes(1);

    const inputs = (harness.appendToStreams.mock.calls[0]?.[0] ?? []) as readonly AppendToStreamInput[];
    // Claim, account, user, membership, two Consents, two authority guards.
    expect(inputs).toHaveLength(8);

    const guards = inputs.filter((input) => input.streamId.startsWith("platform-policy."));
    expect(guards.map((guard) => guard.streamId)).toEqual([
      authorityStreamFor("terms-of-service"),
      authorityStreamFor("privacy-policy"),
    ]);
    for (const guard of guards) {
      expect(guard.events, "an activation guard contributes no history").toEqual([]);
      expect(guard.expectedVersion).toBe(ACTIVE_AUTHORITY_REVISION);
    }
  });

  it.each([
    ["the first member's", { terms: ACTIVE_AUTHORITY_REVISION + 1, privacy: ACTIVE_AUTHORITY_REVISION }],
    ["the second member's", { terms: ACTIVE_AUTHORITY_REVISION, privacy: ACTIVE_AUTHORITY_REVISION + 1 }],
  ])(
    "aborts the claim, account, user, membership and every Consent when %s authority has moved",
    async (_label, revisions) => {
      const harness = buildHarness();
      await seedBothAuthorities(harness, revisions);

      const aborted = await register(harness);

      expect(aborted.status).toBe(409);
      expect(aborted.body).toMatchObject({ error: { code: "conflict" } });
      expect(identityStreams(harness.store), "a moved authority leaves no partial identity").toEqual([]);
      // Bounded: two attempts, never a third. Nothing was claimed, so the
      // second pass mints its own participant ids -- what has to be identical
      // is the SHAPE of the batch, including both activation guards.
      expect(harness.appendToStreams).toHaveBeenCalledTimes(2);
      for (const call of [0, 1]) {
        const streamIds = batchStreamIds(harness.appendToStreams, call);
        expect(streamIds, `attempt ${call + 1} batch size`).toHaveLength(8);
        expect(streamIds.filter((streamId) => streamId.startsWith("platform-policy."))).toEqual([
          authorityStreamFor("terms-of-service"),
          authorityStreamFor("privacy-policy"),
        ]);
      }
    },
  );

  it("releases the display-name reservation an aborted attempt took", async () => {
    const harness = buildHarness();
    await seedBothAuthorities(harness, { terms: ACTIVE_AUTHORITY_REVISION, privacy: ACTIVE_AUTHORITY_REVISION + 1 });

    await register(harness);

    const deletes = vi
      .mocked(harness.services.db.query)
      .mock.calls.filter(([sql]) => String(sql).includes("DELETE FROM identity_account_display_name_reservations"));
    expect(deletes.length, "each aborted attempt releases its own reservation").toBe(2);
  });
});

describe("AC5/AC7 the current bundle is only resolved by an attempt that appends", () => {
  it("resolves the bundle once per append-producing attempt", async () => {
    const harness = buildHarness();
    await seedBothAuthorities(harness, {
      terms: ACTIVE_AUTHORITY_REVISION,
      privacy: ACTIVE_AUTHORITY_REVISION,
    });

    await register(harness);

    expect(harness.bundles.resolveCount()).toBe(1);
  });

  it("resolves no bundle and reads no authority on a complete committed recovery", async () => {
    const harness = buildHarness();
    await seedBothAuthorities(harness, {
      terms: ACTIVE_AUTHORITY_REVISION,
      privacy: ACTIVE_AUTHORITY_REVISION,
    });
    expect((await register(harness)).status).toBe(201);

    const resolvesBefore = harness.bundles.resolveCount();
    const readsBefore = harness.bundles.authority().reads.length;
    harness.appendToStreams.mockClear();

    const recovered = await register(harness);

    expect(recovered.status).toBe(201);
    expect(harness.bundles.resolveCount() - resolvesBefore).toBe(0);
    expect(harness.bundles.authority().reads.length - readsBefore).toBe(0);
    // The recovery still performs its one all-or-nothing append, and that batch
    // carries only the existing participants' zero-event version guards -- no
    // activation guard, because nothing was resolved.
    expect(harness.appendToStreams).toHaveBeenCalledTimes(1);
    const inputs = (harness.appendToStreams.mock.calls[0]?.[0] ?? []) as readonly AppendToStreamInput[];
    expect(inputs).toHaveLength(6);
    expect(inputs.every((input) => input.events.length === 0)).toBe(true);
    expect(inputs.some((input) => input.streamId.startsWith("platform-policy."))).toBe(false);
  });
});

describe("AC5 a submission the current bundle no longer derives is superseded", () => {
  it("refuses an unclaimed attempt with the exact superseded body and appends nothing", async () => {
    const harness = buildHarness({ bundles: fixtureRegistrationConsentBundleResolver([MEMBERS[0]]) });
    await seedBothAuthorities(harness, { terms: ACTIVE_AUTHORITY_REVISION, privacy: 0 });

    const refused = await register(harness, BUNDLE);

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: {
        code: REGISTRATION_CONSENT_EXPIRED_CODE,
        reason: "superseded",
        message: "The registration consent resolution no longer matches the current required bundle.",
      },
    });
    expect(identityStreams(harness.store)).toEqual([]);
    expect(harness.appendToStreams).not.toHaveBeenCalled();
  });

  it("redacts an unresolvable bundle into the generic 500 and appends nothing", async () => {
    // Publication says v1, the authority says v2: a contradiction, not a
    // shorter bundle. Neither the reason nor the policy may reach the caller.
    const harness = buildHarness({
      bundles: fixtureRegistrationConsentBundleResolver(MEMBERS, {
        authority: fixtureBundleAuthorityReader([
          { policyKey: "terms-of-service", version: "v9" },
          { policyKey: "privacy-policy", version: "v3" },
        ]),
      }),
    });
    await seedBothAuthorities(harness, {
      terms: ACTIVE_AUTHORITY_REVISION,
      privacy: ACTIVE_AUTHORITY_REVISION,
    });

    const redacted = await register(harness, BUNDLE);

    expect(redacted.status).toBe(500);
    expect(redacted.body).toEqual({ error: { code: "internal_error", message: "Internal server error." } });
    expect(identityStreams(harness.store)).toEqual([]);
  });
});

describe("AC13 exempt paths neither mint nor submit a registration bundle", () => {
  it("creates a guest account and claims it without resolving any bundle", async () => {
    const harness = buildHarness();
    const app = buildIdentityApi(harness.services);
    app.onError(errorHandler);

    const guest = await app.request("/internal/auth/guest-accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "guest@pokebash.example", displayName: "Guest" }),
    });
    expect(guest.status).toBe(201);
    const guestAccount = (await guest.json()) as { accountId: string };

    const user = await app.request("/internal/auth/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "guest@pokebash.example", displayName: "Guest" }),
    });
    expect(user.status).toBe(201);
    const guestUser = (await user.json()) as { userId: string };

    const claimed = await app.request(`/internal/auth/guest-accounts/${guestAccount.accountId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: guestUser.userId, roleKey: "owner" }),
    });
    expect(claimed.status).toBe(201);

    expect(harness.bundles.resolveCount(), "no guest path resolves a registration bundle").toBe(0);
    expect(harness.bundles.authority().reads, "and none reads an activation authority").toEqual([]);
    expect(harness.store.streamIdsWithPrefix("identity.consent-"), "and none records a Consent").toEqual([]);
  });
});
