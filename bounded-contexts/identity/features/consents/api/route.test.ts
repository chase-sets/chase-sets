import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { IdentityApiEnv } from "../../../api";
import { consentRoutes } from "./route";
import type { ConsentServices } from "./runtime";

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

function buildApp(services: ConsentServices, currentActor: ResolvedActor | null = actor) {
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", currentActor);
    if (currentActor) {
      c.set("context", buildContext(currentActor));
    }
    await next();
  });
  app.route("/consents", consentRoutes(services));
  return app;
}

function buildServices(consent: Record<string, unknown> | null = null) {
  return {
    commandHandler: vi.fn(async () => ({
      version: 2,
      state: { status: "withdrawn", withdrawnAt: "2026-07-15T00:00:00.000Z" },
      newEvents: [],
      storedEvents: [],
    })),
    getConsent: vi.fn(async () => consent),
    listConsents: vi.fn(async () => ({ items: [], total: 0 })),
    projectors: [],
  } as unknown as ConsentServices & {
    commandHandler: ReturnType<typeof vi.fn>;
    getConsent: ReturnType<typeof vi.fn>;
    listConsents: ReturnType<typeof vi.fn>;
  };
}

describe("consent API route", () => {
  it("requires an authenticated actor and ignores caller-supplied subject filters", async () => {
    const services = buildServices();

    const response = await buildApp(services, null).request("/consents?userId=usr_victim&accountId=acc_victim");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "authentication_required" },
    });
    expect(services.listConsents).not.toHaveBeenCalled();
  });

  it("scopes ordinary actors to their own user and account", async () => {
    const services = buildServices();

    const response = await buildApp(services).request("/consents?userId=usr_victim&accountId=acc_victim");

    expect(response.status).toBe(200);
    expect(services.listConsents).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: actor.userId,
        accountId: actor.accountId,
      }),
    );
  });

  it("allows security managers to apply explicit subject filters", async () => {
    const services = buildServices();

    const response = await buildApp(services, { ...actor, permissions: ["security.manage"] }).request(
      "/consents?userId=usr_subject&accountId=acc_subject",
    );

    expect(response.status).toBe(200);
    expect(services.listConsents).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "usr_subject",
        accountId: "acc_subject",
      }),
    );
  });

  it("withdraws the actor's current user consent on its event stream", async () => {
    const services = buildServices({
      consent_id: "cns_1",
      subject_type: "user",
      user_id: actor.userId,
      account_id: actor.accountId,
      policy_key: "marketing-email",
      policy_version: "v1",
      status: "recorded",
      recorded_at: "2026-07-01T00:00:00.000Z",
      withdrawn_at: null,
      updated_at: "2026-07-01T00:00:00.000Z",
      is_current: true,
    });

    const response = await buildApp(services).request("/consents/cns_1/withdraw", { method: "POST" });

    expect(response.status).toBe(200);
    expect(services.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "identity.consent-cns_1",
        command: expect.objectContaining({ type: "WithdrawConsent" }),
      }),
    );
    await expect(response.json()).resolves.toMatchObject({ id: "cns_1", version: 2, status: "withdrawn" });
  });

  it("does not allow an actor to withdraw another user's consent", async () => {
    const services = buildServices({
      consent_id: "cns_2",
      subject_type: "user",
      user_id: "usr_other",
      account_id: "acc_other",
      policy_key: "marketing-email",
      policy_version: "v1",
      status: "recorded",
      recorded_at: "2026-07-01T00:00:00.000Z",
      withdrawn_at: null,
      updated_at: "2026-07-01T00:00:00.000Z",
      is_current: true,
    });

    const response = await buildApp(services, { ...actor, permissions: ["security.manage"] }).request(
      "/consents/cns_2/withdraw",
      { method: "POST" },
    );

    expect(response.status).toBe(403);
    expect(services.commandHandler).not.toHaveBeenCalled();
  });
});
