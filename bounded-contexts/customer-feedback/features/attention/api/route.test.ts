import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CustomerFeedbackApiEnv } from "./route";
import { buildCustomerFeedbackAttentionApi } from "./route";

const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_operator" as never, forAccountId: "acc_platform" as never },
};

function buildApp(permissions: readonly string[] | null) {
  const executeByCaseId = vi.fn(async (_caseId, command: { type: string }) => ({
    caseId: "fbcase_01",
    status: command.type === "ReopenFeedbackCase" ? "triaged" : "actioned",
    priority: "high",
    ownerId: "usr_operator",
    dueAt: null,
    followUpStatus: command.type === "RequestFeedbackCaseFollowUp" ? "requested" : "not-requested",
    followUpDeliveryStatus: command.type === "RequestFeedbackCaseFollowUp" ? "pending" : "not-requested",
  }));
  const app = new Hono<CustomerFeedbackApiEnv>();
  app.use("*", async (c, next) => {
    c.set(
      "actor",
      permissions
        ? {
            sessionId: "ses_1",
            tenantId: "tnt_test",
            userId: "usr_operator",
            accountId: "acc_platform",
            membershipId: "mem_1",
            roleKey: "support",
            permissions,
          }
        : null,
    );
    c.set("context", permissions ? context : null);
    await next();
  });
  app.route("/", buildCustomerFeedbackAttentionApi({ db: { query: vi.fn() }, cases: { executeByCaseId } } as never));
  return { app, executeByCaseId };
}

describe("Customer Feedback attention API authorization", () => {
  it("rejects unauthenticated attention deep links before querying the read model", async () => {
    const { app } = buildApp(null);
    const response = await app.request("/attention");
    expect(response.status).toBe(401);
  });

  it("allows notify-only operators to request follow-up but not reopen cases", async () => {
    const { app, executeByCaseId } = buildApp(["support.notify"]);
    const followUp = await app.request("/cases/fbcase_01/follow-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consentVersion: "feedback-follow-up-v1", channel: "web", templateVersion: 2 }),
    });
    expect(followUp.status).toBe(200);
    expect(executeByCaseId).toHaveBeenCalledWith(
      "fbcase_01",
      expect.objectContaining({
        type: "RequestFeedbackCaseFollowUp",
        actor: { actorId: "usr_operator", authority: "notify-feedback-cases" },
      }),
      context,
    );
    expect((await app.request("/cases/fbcase_01/reopen", { method: "POST" })).status).toBe(403);
  });

  it("allows managers to reopen and returns the committed snapshot", async () => {
    const { app } = buildApp(["support.manage"]);
    const response = await app.request("/cases/fbcase_01/reopen", { method: "POST" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ caseId: "fbcase_01", status: "triaged" });
  });
});
