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

function buildServices() {
  return {
    commandHandler: vi.fn(),
    listConsents: vi.fn(async () => ({ items: [], total: 0 })),
    projectors: [],
  } satisfies ConsentServices;
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
});
