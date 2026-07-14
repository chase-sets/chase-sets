import type { AuthenticatedApiEnv, ResolvedActor } from "@chase-sets/auth-context";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildCustomerFeedbackApi } from "./admin-http";
import type { CsatAdminReadPort } from "./runtime";

const actor = (permissions: readonly string[]): ResolvedActor => ({
  sessionId: "ses_test",
  tenantId: "tnt_test",
  userId: "usr_test",
  accountId: "acc_test",
  membershipId: "mem_test",
  roleKey: "platform-admin",
  permissions,
});

function port(): CsatAdminReadPort {
  return {
    readAdminAnalytics: vi.fn(async () => ({ analytics: true }) as never),
    listAdminQueue: vi.fn(
      async () =>
        ({
          items: [
            {
              invitationId: "=unsafe",
              state: "submitted",
              surveyVersion: { surveyKind: "transactional-csat", surveyVersion: "v1", questionVersion: "q1" },
              outcomeCode: "checkout.completed",
              customerRole: "buyer",
              eligibleAt: "2026-07-13T00:00:00.000Z",
              issuedAt: null,
              presentedAt: null,
              submittedAt: null,
              dismissedAt: null,
              expiredAt: null,
              rating: 5,
              followUpConsent: false,
            },
          ],
          nextCursor: null,
          previousCursor: null,
          limit: 100,
        }) satisfies Awaited<ReturnType<CsatAdminReadPort["listAdminQueue"]>>,
    ),
    recordAdminExport: vi.fn(async () => undefined),
  };
}

function appFor(permissions: readonly string[], readPort = port()) {
  const app = new Hono<AuthenticatedApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor(permissions));
    await next();
  });
  app.route("/", buildCustomerFeedbackApi(readPort));
  return { app, readPort };
}

describe("Customer Feedback admin API", () => {
  it("allows view staff to read projection analytics and queue data", async () => {
    const { app, readPort } = appFor(["platform-feedback.view"]);
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(readPort.readAdminAnalytics).toHaveBeenCalled();
    expect(readPort.listAdminQueue).toHaveBeenCalled();
  });

  it("keeps export behind the separate capability and neutralizes formula cells", async () => {
    const denied = await appFor(["platform-feedback.view"]).app.request("/export");
    expect(denied.status).toBe(403);

    const { app, readPort } = appFor(["platform-feedback.export"]);
    const response = await app.request("/export");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("'=unsafe");
    expect(body).not.toContain("comment");
    expect(readPort.recordAdminExport).toHaveBeenCalledWith(
      expect.objectContaining({ result: "completed", rowCount: 1 }),
    );
  });

  it("rejects anonymous reads", async () => {
    const app = new Hono<AuthenticatedApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", null);
      await next();
    });
    app.route("/", buildCustomerFeedbackApi(port()));
    expect((await app.request("/")).status).toBe(401);
  });
});
