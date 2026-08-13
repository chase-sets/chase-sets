import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import {
  ConsentActivationAuthorityError,
  consentActivationGuardAppendInput,
  consentActivationAuthorityStreamId,
  type ValidatedConsentActivationGuard,
} from "@chase-sets/platform-policy/consent-activation-authority";
import type { IdentityApiEnv } from "../api";
import { termsOfServiceConsentRoutes, type TermsRouteDeps } from "../features/consents/api/terms-route";
import { createConsentRuntime } from "../features/consents/api/runtime";
import { identityConsentActiveVersionPolicyFor } from "../features/consents/domain/terms-of-service-policy";
import { TERMS_OF_SERVICE_CONSENT_POLICY_KEY } from "../features/consents/domain/terms-of-service";
import {
  activeSnapshot,
  deactivatedSnapshot,
  FIXTURE_ACTIVE_AUTHORITY_REVISION,
  recordingAuthorityReader,
  registeredNeverActivatedSnapshot,
  seedFixtureAuthorityRevision,
  type RecordingAuthorityReader,
} from "./consent-activation-authority-fixtures";
import { createInMemoryEventStore, type InMemoryEventStore } from "./in-memory-event-store";

/**
 * The Terms of Service write path against a LIVE consent member.
 *
 * The shipped corpus compiles every policy as not consent-activatable, so the
 * only way to reach the recording arms at all is to supply a publication that
 * is. The mock replaces exactly the compiled publication records -- everything
 * else in `@chase-sets/public-docs`, and every line of Identity's own
 * derivation, authorization and append code, is the real thing. A test that
 * mocked Identity instead would prove nothing about admission.
 */
vi.mock("@chase-sets/public-docs", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/public-docs")>("@chase-sets/public-docs");
  const activatable = (policyKey: "terms-of-service" | "privacy-policy", version: `v${number}`) => ({
    ...actual.publicPolicyPublicationRecords[policyKey],
    version,
    publicationStatus: "published" as const,
    effectiveAt: "2026-07-01T00:00:00.000Z",
    counselApprovalReference: "counsel-fixture-1",
    consentActivatable: true,
  });

  return {
    ...actual,
    publicPolicyPublicationRecords: {
      ...actual.publicPolicyPublicationRecords,
      "terms-of-service": activatable("terms-of-service", "v4"),
      "privacy-policy": activatable("privacy-policy", "v2"),
    },
  };
});

const TERMS_ACTIVE_VERSION = "v4";
const TERMS_AUTHORITY_KEY = identityConsentActiveVersionPolicyFor(TERMS_OF_SERVICE_CONSENT_POLICY_KEY).policyKey;
const TERMS_AUTHORITY_STREAM = consentActivationAuthorityStreamId(TERMS_AUTHORITY_KEY);

const actor: ResolvedActor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_member",
  accountId: "acc_member",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: [],
};

function contextFor(auditUserId: string, auditAccountId: string): EventStoreContext {
  return {
    tenantId: "tnt_identity" as never,
    audit: {
      performedByUserId: auditUserId as never,
      forAccountId: auditAccountId as never,
    },
    trace: {},
  };
}

type Harness = Readonly<{
  deps: TermsRouteDeps;
  app: Hono<IdentityApiEnv>;
  store: InMemoryEventStore;
  authority: RecordingAuthorityReader;
  appendToStreams: ReturnType<typeof vi.fn>;
  /** How many authority reads had happened when each append was issued. */
  readsAtAppend: readonly number[];
  consentRows: Record<string, unknown>[];
}>;

/**
 * A route wired to the real Consent runtime over a real in-memory event store.
 *
 * `appendToStreams` is a spy over the store's own implementation rather than a
 * stand-in, so the batch every assertion below inspects is the batch that was
 * actually committed with its real expected-version enforcement.
 */
async function buildHarness(
  options: Readonly<{
    authority?: RecordingAuthorityReader;
    consentRows?: Record<string, unknown>[];
    requestActor?: ResolvedActor | null;
    context?: EventStoreContext;
    /**
     * The revision the authority stream actually holds. Defaults to the one
     * `activeSnapshot` describes, so the guard the append carries matches; a
     * case that moves the authority sets it to something else.
     */
    authorityRevision?: number;
  }> = {},
): Promise<Harness> {
  const store = createInMemoryEventStore();
  const authority =
    options.authority ??
    recordingAuthorityReader({
      [TERMS_AUTHORITY_KEY]: () => activeSnapshot(TERMS_AUTHORITY_KEY, TERMS_ACTIVE_VERSION),
    });
  // Reads are counted AT the append rather than after the response, so the
  // "one read supplied both the version and the guard" invariant is asserted at
  // the moment it has to hold instead of inferred from a final total.
  const readsAtAppend: number[] = [];
  const appendToStreams = vi.fn(async (inputs: readonly AppendToStreamInput[]) => {
    readsAtAppend.push(authority.reads.length);
    return store.appendToStreams!(inputs);
  });
  const consentRows = options.consentRows ?? [];
  const db = { query: vi.fn(async () => ({ rows: consentRows, rowCount: consentRows.length })) };
  const consents = createConsentRuntime({
    eventStore: { ...store, appendToStreams } as typeof store,
    checkpointStore: {
      loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
      saveCheckpoint: async () => undefined,
    },
    db: db as never,
  });
  const deps = {
    db,
    policies: { consentActivation: authority },
    consents,
  } as unknown as TermsRouteDeps;

  await seedFixtureAuthorityRevision(
    store,
    TERMS_OF_SERVICE_CONSENT_POLICY_KEY,
    contextFor(actor.userId, actor.accountId),
    options.authorityRevision ?? FIXTURE_ACTIVE_AUTHORITY_REVISION,
  );

  const requestActor = options.requestActor === undefined ? actor : options.requestActor;
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", requestActor);
    c.set(
      "context",
      options.context ?? contextFor(requestActor?.userId ?? "usr_member", requestActor?.accountId ?? "acc_member"),
    );
    await next();
  });
  app.route("/consents/terms-of-service", termsOfServiceConsentRoutes(deps));
  app.onError(errorHandler);

  return { deps, app, store, authority, appendToStreams, readsAtAppend, consentRows };
}

function recordedConsentStreams(store: InMemoryEventStore) {
  return store.streamIdsWithPrefix("identity.consent-");
}

function currentConsentRow(policyVersion: string, overrides: Record<string, unknown> = {}) {
  return {
    consent_id: "cns_existing",
    subject_type: "user",
    user_id: actor.userId,
    account_id: actor.accountId,
    policy_key: TERMS_OF_SERVICE_CONSENT_POLICY_KEY,
    policy_version: policyVersion,
    status: "recorded",
    recorded_at: "2026-07-02T00:00:00.000Z",
    withdrawn_at: null,
    updated_at: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("AC1/AC4 guard-carried Terms of Service admission", () => {
  it("records an authorized, active, exact-subject acceptance with the authority guard in one batch", async () => {
    const harness = await buildHarness();

    const response = await harness.app.request("/consents/terms-of-service/accept", { method: "POST" });

    expect(response.status).toBe(201);
    expect(recordedConsentStreams(harness.store)).toHaveLength(1);

    // One transaction, two participants: the Consent, and the zero-event guard
    // for the exact authority revision the required version came from.
    expect(harness.appendToStreams).toHaveBeenCalledTimes(1);
    const inputs = (harness.appendToStreams.mock.calls[0]?.[0] ?? []) as readonly AppendToStreamInput[];
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.streamId).toBe(recordedConsentStreams(harness.store)[0]);
    expect(inputs[0]?.expectedVersion).toBe("no_stream");
    expect(inputs[0]?.events).toHaveLength(1);
    expect(inputs[1]).toMatchObject({
      streamId: TERMS_AUTHORITY_STREAM,
      expectedVersion: 2,
      events: [],
    });
  });

  it("records the exact active version the same read produced", async () => {
    const harness = await buildHarness();

    await harness.app.request("/consents/terms-of-service/accept", { method: "POST" });

    const streamId = recordedConsentStreams(harness.store)[0];
    const recorded = (harness.store.streams.get(streamId) ?? [])[0]?.payload as unknown as {
      policyKey: string;
      policyVersion: string;
      userId: string;
      accountId: string;
    };
    expect(recorded.policyKey).toBe(TERMS_OF_SERVICE_CONSENT_POLICY_KEY);
    expect(recorded.policyVersion).toBe(TERMS_ACTIVE_VERSION);
    expect(recorded.userId).toBe(actor.userId);
    expect(recorded.accountId).toBe(actor.accountId);
  });

  it("stays 200 and appends nothing when the subject is already current", async () => {
    const harness = await buildHarness({ consentRows: [currentConsentRow(TERMS_ACTIVE_VERSION)] });

    const response = await harness.app.request("/consents/terms-of-service/accept", { method: "POST" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      policyKey: TERMS_OF_SERVICE_CONSENT_POLICY_KEY,
      requiredVersion: TERMS_ACTIVE_VERSION,
      accepted: true,
    });
    expect(harness.appendToStreams).not.toHaveBeenCalled();
    expect(recordedConsentStreams(harness.store)).toEqual([]);
  });

  // Subject and policy-key filtering is the shipped host query's own SQL and is
  // covered where that query runs against a database. What is decided in this
  // process, and therefore assertable here, is the version and the status.
  it.each([
    ["a superseded version", currentConsentRow("v3")],
    ["a withdrawn record", currentConsentRow(TERMS_ACTIVE_VERSION, { status: "withdrawn" })],
  ])("does not treat %s as already current", async (_label, row) => {
    // The row is present evidence, not satisfaction: acceptance requires the
    // CURRENT state to be recorded at the exact required version, so the route
    // records rather than short-circuiting.
    const harness = await buildHarness({ consentRows: [row] });

    const response = await harness.app.request("/consents/terms-of-service/accept", { method: "POST" });

    expect(response.status).toBe(201);
    expect(harness.appendToStreams).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an authority that never activated", () => registeredNeverActivatedSnapshot(TERMS_AUTHORITY_KEY)],
    ["an authority that was deactivated", () => deactivatedSnapshot(TERMS_AUTHORITY_KEY)],
    [
      "an authority active at a version the publication does not carry",
      () => activeSnapshot(TERMS_AUTHORITY_KEY, "v9"),
    ],
  ])("refuses to record against %s and appends nothing", async (_label, snapshot) => {
    const harness = await buildHarness({
      authority: recordingAuthorityReader({ [TERMS_AUTHORITY_KEY]: snapshot }),
    });

    const response = await harness.app.request("/consents/terms-of-service/accept", { method: "POST" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "terms_of_service_not_active" } });
    expect(harness.appendToStreams).not.toHaveBeenCalled();
  });

  it("refuses to record when the authority cannot be validated at all", async () => {
    const harness = await buildHarness({
      authority: recordingAuthorityReader({
        [TERMS_AUTHORITY_KEY]: () => {
          throw new ConsentActivationAuthorityError("history_too_long", "too long");
        },
      }),
    });

    const response = await harness.app.request("/consents/terms-of-service/accept", { method: "POST" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "terms_of_service_not_active" } });
    expect(harness.appendToStreams).not.toHaveBeenCalled();
  });
});

describe("AC3 authorization and publication eligibility precede any authority read", () => {
  it("rejects a shared platform principal with zero authority reads", async () => {
    const guest: ResolvedActor = { ...actor, userId: "usr_guest_checkout", accountId: "acc_guest" };
    const harness = await buildHarness({ requestActor: guest, context: contextFor("usr_guest_checkout", "acc_guest") });

    const response = await harness.app.request("/consents/terms-of-service/accept", { method: "POST" });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "consent_shared_principal_forbidden" } });
    expect(harness.authority.reads, "an unauthorized request reads no activation authority").toEqual([]);
    expect(harness.appendToStreams).not.toHaveBeenCalled();
  });

  it("rejects a subject that does not match the authoritative audit identity with zero authority reads", async () => {
    // The acting actor and the request audit identity disagree: the acceptance
    // would be recorded for somebody other than whoever the request is running
    // as. Decided before the version is even resolved.
    const harness = await buildHarness({ context: contextFor("usr_someone_else", "acc_someone_else") });

    const response = await harness.app.request("/consents/terms-of-service/accept", { method: "POST" });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "consent_user_not_authorized" } });
    expect(harness.authority.reads).toEqual([]);
    expect(harness.appendToStreams).not.toHaveBeenCalled();
  });

  it("rejects a malformed audit identity with zero authority reads", async () => {
    const harness = await buildHarness({ context: contextFor("not-a-user-id", "acc_member") });

    const response = await harness.app.request("/consents/terms-of-service/accept", { method: "POST" });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "consent_authorization_malformed" } });
    expect(harness.authority.reads).toEqual([]);
  });

  it("reads the authority exactly once before the append that records the acceptance", async () => {
    const harness = await buildHarness();

    await harness.app.request("/consents/terms-of-service/accept", { method: "POST" });

    // Exactly one read had happened when the only append was issued: the
    // recorded version and the committed guard came from that same read. Two
    // reads before the append would be two moments, which is the race this
    // slice closes.
    expect(harness.readsAtAppend).toEqual([1]);
    // A second read shapes the 201 acceptance-status body afterwards; it
    // decides nothing that was written.
    expect(harness.authority.reads).toEqual([TERMS_AUTHORITY_KEY, TERMS_AUTHORITY_KEY]);
  });
});

describe("AC4 guard movement between resolution and append", () => {
  it("exhausts both attempts to the existing 409 conflict and records nothing when the authority has moved", async () => {
    // The authority stream holds a revision the resolution's guard does not
    // describe -- exactly the state a concurrent activation leaves behind
    // between the read and the append.
    const harness = await buildHarness({ authorityRevision: FIXTURE_ACTIVE_AUTHORITY_REVISION + 1 });

    const response = await harness.app.request("/consents/terms-of-service/accept", { method: "POST" });

    // Two attempts, then the existing generic 409 `conflict` from the mounted
    // platform handler -- not an invented code, and not a Consent recorded
    // against a revision that is no longer current.
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "conflict" } });
    expect(harness.appendToStreams).toHaveBeenCalledTimes(2);
    expect(harness.authority.reads, "each attempt resolves afresh").toEqual([TERMS_AUTHORITY_KEY, TERMS_AUTHORITY_KEY]);
    expect(recordedConsentStreams(harness.store), "a moved authority records no Consent").toEqual([]);
  });
});

describe("AC2 only the canonical decoder mints an admitting guard", () => {
  it("rejects a structurally identical guard the decoder did not mint", async () => {
    // Same policy key, same stream, same expected version -- and refused,
    // because provenance is the property being checked, not shape.
    const forged = Object.freeze({
      policyKey: TERMS_AUTHORITY_KEY,
      streamId: TERMS_AUTHORITY_STREAM,
      expectedVersion: 2,
    }) as unknown as ValidatedConsentActivationGuard;

    expect(() => consentActivationGuardAppendInput(forged, contextFor(actor.userId, actor.accountId))).toThrowError(
      expect.objectContaining({ code: "unvalidated_activation_guard" }),
    );
  });

  it("admits the guard the decoder minted from the same read", () => {
    const minted = activeSnapshot(TERMS_AUTHORITY_KEY, TERMS_ACTIVE_VERSION).guard;

    const input = consentActivationGuardAppendInput(minted, contextFor(actor.userId, actor.accountId));

    expect(input).toMatchObject({ streamId: TERMS_AUTHORITY_STREAM, expectedVersion: 2, events: [] });
  });
});
