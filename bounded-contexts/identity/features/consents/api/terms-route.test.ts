import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import { publicPolicyPublicationRecords } from "@chase-sets/public-docs";
import type { IdentityApiEnv } from "../../../api";
import type { ConsentPublicationRegistry } from "../domain/consent-activation";
import { termsOfServiceConsentRoutes, type TermsRouteDeps } from "./terms-route";

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
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("actor", currentActor);
    if (currentActor) {
      c.set("context", buildContext(currentActor));
    }
    await next();
  });
  app.route("/consents/terms-of-service", termsOfServiceConsentRoutes(deps));
  return app;
}

function buildDeps(
  consentRows: readonly Record<string, unknown>[],
  requiredVersion: `v${number}` = "v2",
  options: Readonly<{ source?: "policy" | "fallback"; consentActivatable?: boolean }> = {},
) {
  const commandHandler = vi.fn(async () => ({
    version: 1,
    state: { id: "cns_new" },
    newEvents: [],
    storedEvents: [],
  }));
  const db = { query: vi.fn(async () => ({ rows: consentRows, rowCount: consentRows.length })) };
  const policies = {
    resolvePolicy: vi.fn(async () => ({
      policyKey: "identity.terms-of-service-active-version",
      value: { version: requiredVersion },
      source: options.source ?? ("policy" as const),
      documentId: options.source === "fallback" ? null : "pol_1",
      effectiveFrom: options.source === "fallback" ? null : "2026-01-01T00:00:00.000Z",
      effectiveUntil: null,
      resolvedAt: "2026-07-01T00:00:00.000Z",
    })),
  };
  const consentPublications = {
    ...publicPolicyPublicationRecords,
    "terms-of-service": {
      ...publicPolicyPublicationRecords["terms-of-service"],
      version: requiredVersion,
      publicationStatus: options.consentActivatable === false ? "counsel-review-required" : "published",
      consentActivatable: options.consentActivatable ?? true,
    },
  } as ConsentPublicationRegistry;
  return {
    consents: { commandHandler },
    db,
    policies,
    consentPublications,
    commandHandler,
  } as unknown as TermsRouteDeps & {
    commandHandler: typeof commandHandler;
    db: typeof db;
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

  it("rejects acceptance when the version is unpublished or has no active policy document", async () => {
    const unpublished = buildDeps([], "v2", { consentActivatable: false });
    const unpublishedResponse = await buildApp(unpublished).request("/consents/terms-of-service/accept", {
      method: "POST",
    });
    expect(unpublishedResponse.status).toBe(400);
    expect(unpublished.commandHandler).not.toHaveBeenCalled();

    const unactivated = buildDeps([], "v2", { source: "fallback" });
    const unactivatedResponse = await buildApp(unactivated).request("/consents/terms-of-service/accept", {
      method: "POST",
    });
    expect(unactivatedResponse.status).toBe(400);
    expect(unactivated.commandHandler).not.toHaveBeenCalled();
  });

  it("is idempotent: accepting again when already current does not record a duplicate consent", async () => {
    const deps = buildDeps(
      [
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
      ],
      "v2",
    );
    const app = buildApp(deps);

    const response = await app.request("/consents/terms-of-service/accept", { method: "POST" });

    expect(response.status).toBe(200);
    expect(deps.commandHandler).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ accepted: true, acceptedVersion: "v2" }));
  });
});
