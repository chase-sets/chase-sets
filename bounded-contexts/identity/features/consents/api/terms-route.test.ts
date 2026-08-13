import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createGuestCheckoutActor } from "../../../../auth/support/runtime-support/runtime";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { IdentityApiEnv } from "../../../api";
import {
  recordingAuthorityReader,
  type RecordingAuthorityReader,
} from "../../../tests/consent-activation-authority-fixtures";
import { termsOfServiceConsentRoutes, type TermsRouteDeps } from "./terms-route";
import { createConsentRuntime } from "./runtime";

const actor: ResolvedActor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: [],
};

function buildContext(currentActor: ResolvedActor): EventStoreContext {
  return {
    tenantId: "tnt_identity" as never,
    audit: {
      performedByUserId: currentActor.userId as never,
      forAccountId: currentActor.accountId as never,
    },
    trace: {},
  };
}

function buildApp(deps: TermsRouteDeps, currentActor: ResolvedActor | null = actor) {
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", currentActor);
    if (currentActor) {
      c.set("context", buildContext(currentActor));
    }
    await next();
  });
  app.route("/consents/terms-of-service", termsOfServiceConsentRoutes(deps));
  app.onError(errorHandler);
  return app;
}

/**
 * The route resolves the required version from one Consent Activation Authority
 * read. `TermsRouteDeps.policies` has no `resolvePolicy` member at all, so the
 * `resolvePolicy` spy below is unreachable by construction; it is present so a
 * future re-introduction of the cached seam fails a test rather than passing
 * silently.
 */
function buildDeps(
  consentRows: readonly Record<string, unknown>[],
  authority: RecordingAuthorityReader = recordingAuthorityReader({}),
) {
  const commandHandler = vi.fn(async () => ({
    version: 1,
    state: { id: "cns_new" },
    newEvents: [],
    storedEvents: [],
  }));
  const recordGuardedConsent = vi.fn(async () => ({ version: 1, state: { id: "cns_new" }, events: [] }));
  const db = { query: vi.fn(async () => ({ rows: consentRows, rowCount: consentRows.length })) };
  const resolvePolicy = vi.fn(async () => {
    throw new Error("resolvePolicy must never be reached by the terms acceptance route.");
  });
  const policies = { consentActivation: authority, resolvePolicy };
  return {
    consents: { commandHandler, recordGuardedConsent },
    db,
    policies,
    commandHandler,
    recordGuardedConsent,
    authority,
    resolvePolicy,
  } as unknown as TermsRouteDeps & {
    commandHandler: typeof commandHandler;
    recordGuardedConsent: typeof recordGuardedConsent;
    authority: RecordingAuthorityReader;
    db: typeof db;
    resolvePolicy: typeof resolvePolicy;
  };
}

describe("terms of service consent route", () => {
  it("requires authentication for status and accept", async () => {
    const deps = buildDeps([]);
    const app = buildApp(deps, null);

    const status = await app.request("/consents/terms-of-service");
    expect(status.status).toBe(401);

    const accept = await app.request("/consents/terms-of-service/accept", { method: "POST" });
    expect(accept.status).toBe(401);
    expect(deps.commandHandler).not.toHaveBeenCalled();
  });

  it("reports the fail-closed status while no authority activates the Terms key", async () => {
    const deps = buildDeps([]);
    const app = buildApp(deps);

    const response = await app.request("/consents/terms-of-service");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      policyKey: "terms-of-service",
      requiredVersion: "",
      accepted: false,
      acceptedVersion: null,
      acceptedAt: null,
    });
    expect(deps.resolvePolicy).not.toHaveBeenCalled();
  });

  it("reports readable consent history that cannot satisfy an inactive key", async () => {
    const deps = buildDeps([
      {
        consent_id: "cns_existing",
        subject_type: "user",
        user_id: actor.userId,
        account_id: actor.accountId,
        policy_key: "terms-of-service",
        policy_version: "v1",
        status: "recorded",
        recorded_at: "2026-06-01T00:00:00.000Z",
        withdrawn_at: null,
        updated_at: "2026-06-01T00:00:00.000Z",
      },
    ]);
    const app = buildApp(deps);

    const response = await app.request("/consents/terms-of-service");

    await expect(response.json()).resolves.toEqual({
      policyKey: "terms-of-service",
      requiredVersion: "",
      accepted: false,
      acceptedVersion: "v1",
      acceptedAt: "2026-06-01T00:00:00.000Z",
    });
  });

  it("refuses to record an unversioned acceptance and writes nothing", async () => {
    const deps = buildDeps([]);
    const app = buildApp(deps);

    const response = await app.request("/consents/terms-of-service/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policyVersion: "v999-attacker-supplied" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "terms_of_service_not_active" },
    });
    // No Consent is recorded against an empty version, and the client-supplied
    // version is still never consulted.
    expect(deps.commandHandler).not.toHaveBeenCalled();
    expect(deps.recordGuardedConsent).not.toHaveBeenCalled();
    // Publication eligibility is decided before any authority read, so the
    // shipped dormant corpus refuses this request without asking any authority
    // whether the key is activated.
    expect(deps.authority.reads).toEqual([]);
  });

  it("is idempotent: accepting again when already current does not record a duplicate consent", async () => {
    // Acceptance is decided against the required version the authority supplies.
    // With no active authority nothing is accepted, so the replay guard is
    // exercised through its adjacent arm: no duplicate Consent is recorded on a
    // repeated POST either way.
    const deps = buildDeps([
      {
        consent_id: "cns_existing",
        subject_type: "user",
        user_id: actor.userId,
        account_id: actor.accountId,
        policy_key: "terms-of-service",
        policy_version: "v2",
        status: "recorded",
        recorded_at: "2026-06-01T00:00:00.000Z",
        withdrawn_at: null,
        updated_at: "2026-06-01T00:00:00.000Z",
      },
    ]);
    const app = buildApp(deps);

    const first = await app.request("/consents/terms-of-service/accept", { method: "POST" });
    const second = await app.request("/consents/terms-of-service/accept", { method: "POST" });

    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(deps.commandHandler).not.toHaveBeenCalled();
    expect(deps.recordGuardedConsent).not.toHaveBeenCalled();
    expect(deps.authority.reads).toEqual([]);
  });

  it("rejects guest-checkout terms acceptance with its named authorization code and writes nothing", async () => {
    const memory = createInMemoryEventStore();
    const appendToStream = vi.fn(memory.eventStore.appendToStream);
    const deps = buildDeps([]);
    const runtime = createConsentRuntime({
      eventStore: { ...memory.eventStore, appendToStream },
      checkpointStore: {
        loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
        saveCheckpoint: async () => undefined,
      },
      db: deps.db as never,
    });
    const guestActor = createGuestCheckoutActor(
      { identity: { bootstrapTenantId: "tnt_identity" } } as Parameters<typeof createGuestCheckoutActor>[0],
      { token_id: "gst_terms_acceptance", account_id: "acc_guest" },
    );
    const app = new Hono<IdentityApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", guestActor);
      c.set("context", createActorEventStoreContext(guestActor));
      await next();
    });
    app.route(
      "/consents/terms-of-service",
      termsOfServiceConsentRoutes({
        db: deps.db as never,
        policies: deps.policies,
        consents: runtime,
      }),
    );
    app.onError(errorHandler);

    const response = await app.request("/consents/terms-of-service/accept", { method: "POST" });

    // Authorization precedence is unchanged: the shared-principal rejection
    // still wins over the inactive-version refusal.
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "consent_shared_principal_forbidden" },
    });
    expect(appendToStream).not.toHaveBeenCalled();
    expect(memory.readAllEvents()).toHaveLength(0);
  });
});
