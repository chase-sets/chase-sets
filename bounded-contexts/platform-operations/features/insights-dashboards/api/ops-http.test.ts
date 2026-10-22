import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { describe, expect, it } from "vitest";
import { createOpsDashboardRoutes } from "./ops-http";
import { createOpsDashboardRuntime } from "./ops-runtime";
import type { OpsRepricingSourceShare } from "./ops-contracts";

describe("ops source-share route", () => {
  it.each<OpsRepricingSourceShare>([
    { status: "unavailable", weeks: [], reason: "port-unavailable" },
    { status: "available", weeks: [], decision: { status: "eligible", reasons: [] } },
    {
      status: "available",
      weeks: [
        {
          weekStart: "2026-10-04",
          status: "incomplete",
          reason: "checkpoint-lag",
          eventCount: 0,
          counts: { bulk: 0, policy: 0, manual: 0, unattributed: 0 },
          shares: { bulk: 0, policy: 0, manual: 0 },
          topSellers: [],
        },
      ],
    },
  ])("returns %s without rewriting source-share state", async (report) => {
    const base = createOpsDashboardRuntime({ db: {} as never });
    const app = new Hono<AuthenticatedApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", {
        sessionId: "sess_1",
        tenantId: "tnt_1",
        userId: "usr_1",
        accountId: "acc_1",
        membershipId: "mem_1",
        roleKey: "manager",
        permissions: ["insights-dashboards.view"],
      });
      await next();
    });
    app.route(
      "/ops",
      createOpsDashboardRoutes({
        ...base,
        getPlatformLiquiditySummary: async () => ({
          asOfDay: "2026-10-10",
          sellThroughRate: null,
          medianSpreadAmount: null,
          spreadSampleCount: 0,
        }),
        getRepricingSourceShare: async () => report,
      }),
    );
    const response = await app.request("/ops/summary?from=2026-10-04&to=2026-10-10");
    expect(response.status).toBe(200);
    expect((await response.json()).repricingSourceShare).toEqual(report);
  });
});
