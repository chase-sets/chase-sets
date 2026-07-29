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
  consentActivationAuthorityReaderForTest,
  consentActivationAuthoritySnapshotForTest,
} from "../domain/consent-bundle-test-support";
import { termsOfServiceConsentRoutes, type TermsRouteDeps } from "./terms-route";
import { createConsentRuntime } from "./runtime";

// The route's required version is a published artifact plus an activated
// authority. This suite publishes Terms of Service at v2 and lets each case
// choose what the authority reports, which is the only way the two halves can be
// driven apart -- and driving them apart is the point.
vi.mock("@chase-sets/public-docs", async (importOriginal) => {
  const { publicDocsWithConsentActivatable } = await import("../domain/consent-publication-test-support");
  return publicDocsWithConsentActivatable(importOriginal, ["terms-of-service"], { "terms-of-service": "v2" });
});

const ACTIVATION_KEY = "identity.terms-of-service-active-version";

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

function buildDeps(consentRows: readonly Record<string, unknown>[], activeVersion: string | null = "v2") {
  const commandHandler = vi.fn(async () => ({
    version: 1,
    state: { id: "cns_new" },
    newEvents: [],
    storedEvents: [],
  }));
  const db = { query: vi.fn(async () => ({ rows: consentRows, rowCount: consentRows.length })) };
  const readAuthority = vi.fn(
    activeVersion === null
      ? async (activationPolicyKey: string) =>
          consentActivationAuthoritySnapshotForTest(activationPolicyKey, { status: "inactive" })
      : consentActivationAuthorityReaderForTest({ [ACTIVATION_KEY]: activeVersion }),
  );
  return { consents: { commandHandler }, db, readAuthority, commandHandler } as unknown as TermsRouteDeps & {
    commandHandler: typeof commandHandler;
    db: typeof db;
    readAuthority: typeof readAuthority;
  };
}

function recordedConsentRow(policyVersion: string) {
  return {
    consent_id: "cns_existing",
    subject_type: "user",
    user_id: actor.userId,
    account_id: actor.accountId,
    policy_key: "terms-of-service",
    policy_version: policyVersion,
    status: "recorded",
    recorded_at: "2026-06-01T00:00:00.000Z",
    withdrawn_at: null,
    updated_at: "2026-06-01T00:00:00.000Z",
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

  it("reports not-accepted when no current-version consent fact exists", async () => {
    const deps = buildDeps([]);
    const app = buildApp(deps);

    const response = await app.request("/consents/terms-of-service");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      policyKey: "terms-of-service",
      requiredVersion: "v2",
      accepted: false,
      acceptedVersion: null,
      acceptedAt: null,
    });
  });

  it("records acceptance of the server-resolved active version, never a client-supplied one", async () => {
    const deps = buildDeps([]);
    const app = buildApp(deps);

    const response = await app.request("/consents/terms-of-service/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policyVersion: "v999-attacker-supplied" }),
    });

    expect(response.status).toBe(201);
    expect(deps.commandHandler).toHaveBeenCalledTimes(1);
    expect(deps.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "RecordConsent",
          subjectType: "user",
          userId: actor.userId,
          accountId: actor.accountId,
          policyKey: "terms-of-service",
          policyVersion: "v2",
        }),
      }),
    );
  });

  it("is idempotent: accepting again when already current does not record a duplicate consent", async () => {
    const deps = buildDeps([recordedConsentRow("v2")], "v2");
    const app = buildApp(deps);

    const response = await app.request("/consents/terms-of-service/accept", { method: "POST" });

    expect(response.status).toBe(200);
    expect(deps.commandHandler).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ accepted: true, acceptedVersion: "v2" }));
  });

  describe("the acceptance status is decided by the Consent Activation Authority", () => {
    it("GET does not report a subject holding the superseded version as accepted", async () => {
      // The #6290-F2 shape: the authority is active at v2 and this subject's
      // recorded consent is v1. Under a cached policy value reporting v1 this
      // route answered `accepted: true`.
      const deps = buildDeps([recordedConsentRow("v1")], "v2");

      const response = await buildApp(deps).request("/consents/terms-of-service");

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        policyKey: "terms-of-service",
        requiredVersion: "v2",
        accepted: false,
        acceptedVersion: "v1",
        acceptedAt: "2026-06-01T00:00:00.000Z",
      });
    });

    it("POST does not short-circuit for a superseded version and records the active one", async () => {
      const deps = buildDeps([recordedConsentRow("v1")], "v2");

      const response = await buildApp(deps).request("/consents/terms-of-service/accept", { method: "POST" });

      expect(response.status).toBe(201);
      expect(deps.commandHandler).toHaveBeenCalledTimes(1);
      expect(deps.commandHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.objectContaining({ policyKey: "terms-of-service", policyVersion: "v2" }),
        }),
      );
    });

    it("refuses acceptance and writes nothing when no version is activated", async () => {
      const deps = buildDeps([], null);

      const response = await buildApp(deps).request("/consents/terms-of-service/accept", { method: "POST" });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "consent_policy_not_activated" } });
      expect(deps.commandHandler).not.toHaveBeenCalled();
    });

    it("never consults a policy runtime: the route holds no resolver to consult", async () => {
      const deps = buildDeps([recordedConsentRow("v1")], "v2");
      await buildApp(deps).request("/consents/terms-of-service");

      expect(deps.readAuthority).toHaveBeenCalledWith(ACTIVATION_KEY);
      expect(Object.keys(deps as unknown as Record<string, unknown>)).not.toContain("policies");
    });
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
        readAuthority: deps.readAuthority as never,
        consents: runtime,
      }),
    );
    app.onError(errorHandler);

    const response = await app.request("/consents/terms-of-service/accept", { method: "POST" });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "consent_shared_principal_forbidden" },
    });
    expect(appendToStream).not.toHaveBeenCalled();
    expect(memory.readAllEvents()).toHaveLength(0);
  });
});
