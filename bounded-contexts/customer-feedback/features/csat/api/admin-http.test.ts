import type { AuthenticatedApiEnv, ResolvedActor } from "@chase-sets/auth-context";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildCustomerFeedbackApi } from "./admin-http";
import type { CsatAdminReadPort } from "./runtime";

const actor = (permissions: readonly string[], userId = "usr_test"): ResolvedActor => ({
  sessionId: "ses_test",
  tenantId: "tnt_test",
  userId,
  accountId: "acc_test",
  membershipId: "mem_test",
  roleKey: "platform-admin",
  permissions,
});

function port(): CsatAdminReadPort {
  let artifact: { exportId: string; actorId: string; artifactExpiresAt: string; artifactContent: string } | null = null;
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
    recordAdminExport: vi.fn(async (audit) => {
      if (audit.artifactContent && audit.exportId) {
        artifact = {
          exportId: audit.exportId,
          actorId: audit.actorId,
          artifactExpiresAt: audit.artifactExpiresAt,
          artifactContent: audit.artifactContent,
        };
      }
    }),
    getAdminExportArtifact: vi.fn(async (exportId, actorId, fetchedAt) =>
      artifact &&
      artifact.exportId === exportId &&
      artifact.actorId === actorId &&
      Date.parse(artifact.artifactExpiresAt) > Date.parse(fetchedAt)
        ? artifact
        : null,
    ),
    resolveRetentionPolicy: vi.fn(async () => ({ exportArtifactHours: 24 }) as never),
  };
}

function appFor(permissions: readonly string[], readPort = port(), userId = "usr_test") {
  const app = new Hono<AuthenticatedApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor(permissions, userId));
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
    const denied = await appFor(["platform-feedback.view"]).app.request("/export?reason=case-review");
    expect(denied.status).toBe(403);

    const { app, readPort } = appFor(["customer-feedback.privacy.export-sensitive-feedback"]);
    const response = await app.request("/export?reason=case-review");
    const created = (await response.json()) as { exportId: string };
    expect(response.status).toBe(201);
    const download = await app.request(`/export/${created.exportId}`);
    const body = await download.text();
    expect(download.status).toBe(200);
    expect(body).toContain("'=unsafe");
    expect(body).not.toContain("comment");
    expect(readPort.recordAdminExport).toHaveBeenCalledWith(
      expect.objectContaining({ result: "completed", rowCount: 1, reason: "case-review" }),
    );
  });

  it("fails closed when another actor fetches an export or its artifact has expired", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-14T00:00:00.000Z"));
      const readPort = port();
      const creator = appFor(["customer-feedback.privacy.export-sensitive-feedback"], readPort);
      const created = (await (await creator.app.request("/export?reason=case-review")).json()) as { exportId: string };

      const otherActor = appFor(["customer-feedback.privacy.export-sensitive-feedback"], readPort, "usr_different");
      expect((await otherActor.app.request(`/export/${created.exportId}`)).status).toBe(404);

      vi.setSystemTime(new Date("2026-07-15T00:00:00.001Z"));
      expect((await creator.app.request(`/export/${created.exportId}`)).status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
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
