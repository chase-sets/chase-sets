import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CommercialTermsApiEnv } from "../../../api";
import { createScheduleRoutes } from "./route";
import type { ScheduleServices } from "./runtime";
import type { ResolutionServices } from "../../resolutions/api/runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_admin" as never,
    forAccountId: "acc_admin" as never,
  },
};

function createApp(services: Partial<ScheduleServices>, permissions: readonly string[]) {
  const app = new Hono<CommercialTermsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      sessionId: "ses_test",
      tenantId: "tnt_test",
      userId: "usr_admin",
      accountId: "acc_admin",
      membershipId: "mem_test",
      roleKey: "admin",
      permissions,
    });
    c.set("context", context);
    await next();
  });
  app.route("/", createScheduleRoutes(services as ScheduleServices, {} as ResolutionServices));
  return app;
}

describe("commercial terms schedule routes", () => {
  it("returns a command snapshot when creating a schedule", async () => {
    const createSchedule = vi.fn(async () => ({ scheduleId: "cts_business", version: 1 }));
    const app = createApp({ createSchedule }, ["commercial-terms.manage"]);

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify({
        label: "Business",
        accountType: "business",
        marketplaceSalesFeePercentageBps: 650,
        marketplaceSalesFeeFixedAmount: "0.00",
        shippingAllowancePercentageBps: 750,
        status: "active",
        effectiveFrom: "2026-05-01T00:00:00.000Z",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: "cts_business", version: 1, preview: null });
    expect(createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Business",
        accountType: "business",
        marketplaceSalesFeePercentageBps: 650,
        createdByUserId: "usr_admin",
      }),
      context,
    );
  });

  it("requires manage permission for schedule revisions", async () => {
    const reviseSchedule = vi.fn();
    const app = createApp({ reviseSchedule }, ["commercial-terms.view"]);

    const response = await app.request("/cts_business", {
      method: "PUT",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(reviseSchedule).not.toHaveBeenCalled();
  });

  it("revises schedule terms through the admin API", async () => {
    const reviseSchedule = vi.fn(async () => ({ scheduleId: "cts_business", version: 2 }));
    const app = createApp({ reviseSchedule }, ["commercial-terms.manage"]);

    const response = await app.request("/cts_business", {
      method: "PUT",
      body: JSON.stringify({
        label: "Business revised",
        marketplaceSalesFeePercentageBps: 650,
        marketplaceSalesFeeFixedAmount: "0.00",
        shippingAllowancePercentageBps: 750,
        status: "active",
        effectiveFrom: "2026-05-01T00:00:00.000Z",
        effectiveUntil: null,
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "cts_business", version: 2 });
    expect(reviseSchedule).toHaveBeenCalledWith(
      "cts_business",
      expect.objectContaining({
        label: "Business revised",
        marketplaceSalesFeePercentageBps: 650,
        shippingAllowancePercentageBps: 750,
        revisedByUserId: "usr_admin",
      }),
      context,
    );
  });

  it.each(["status", "effectiveFrom"])("rejects schedule revisions that omit %s", async (missingField) => {
    const reviseSchedule = vi.fn();
    const app = createApp({ reviseSchedule }, ["commercial-terms.manage"]);
    const body: Record<string, unknown> = {
      label: "Business revised",
      marketplaceSalesFeePercentageBps: 650,
      marketplaceSalesFeeFixedAmount: "0.00",
      shippingAllowancePercentageBps: 750,
      status: "active",
      effectiveFrom: "2026-05-01T00:00:00.000Z",
    };
    delete body[missingField];

    const response = await app.request("/cts_business", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(400);
    expect(reviseSchedule).not.toHaveBeenCalled();
  });
});
