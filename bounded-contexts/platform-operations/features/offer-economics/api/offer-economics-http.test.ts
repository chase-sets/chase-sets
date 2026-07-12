import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PlatformOperationsApiEnv } from "../../../api";
import { createOfferEconomicsRoutes } from "./offer-economics-http";
import type { OfferEconomicsServices } from "./offer-economics-runtime";

function createApp(services: Partial<OfferEconomicsServices>, permissions: readonly string[]) {
  const app = new Hono<PlatformOperationsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      sessionId: "ses_test",
      tenantId: "tnt_test",
      userId: "usr_admin",
      accountId: "acc_admin",
      membershipId: "mem_test",
      roleKey: "platform-admin",
      permissions,
    });
    await next();
  });
  app.route("/", createOfferEconomicsRoutes(services as OfferEconomicsServices));
  return app;
}

const sampleSnapshot = {
  from: "2026-05-13",
  to: "2026-07-12",
  listingsCreatedCount: 5,
  lockedSellerAccountCount: 1,
  lockedGmvAmount: "300.00",
  lockedTradeCount: 2,
  platformGmvAmount: "6000.00",
  lockedGmvShareRatio: "0.0500",
  standardFeePercentageBps: 900,
  standardFeeFixedAmount: "0.15",
  standardScheduleSource: { scheduleId: "cts_seed_personal_default", scheduleLabel: "Personal Default" },
  foregoneFeeEstimateAmount: "27.30",
  weeklySellThrough: [],
  protectionReserve: { available: false as const, reason: "pending" },
};

describe("platform-operations offer-economics routes (#4075)", () => {
  it("returns the computed snapshot for insights-dashboards.view actors", async () => {
    const getOfferEconomicsSnapshot = vi.fn(async () => sampleSnapshot);
    const app = createApp({ getOfferEconomicsSnapshot }, ["insights-dashboards.view"]);

    const response = await app.request("/summary?from=2026-05-13&to=2026-07-12");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ snapshot: sampleSnapshot });
    expect(getOfferEconomicsSnapshot).toHaveBeenCalledWith({
      from: "2026-05-13",
      to: "2026-07-12",
      accountType: undefined,
    });
  });

  it("defaults to a trailing 60-day window when no range is given", async () => {
    const getOfferEconomicsSnapshot = vi.fn(
      async (_params: Readonly<{ from: string; to: string; accountType?: string }>) => sampleSnapshot,
    );
    const app = createApp({ getOfferEconomicsSnapshot }, ["insights-dashboards.view"]);

    const response = await app.request("/summary");

    expect(response.status).toBe(200);
    const call = getOfferEconomicsSnapshot.mock.calls[0]?.[0];
    expect(call?.to).toBe(new Date().toISOString().slice(0, 10));
    expect(new Date(call!.from).getTime()).toBeLessThan(new Date(call!.to).getTime());
  });

  it("rejects actors without insights-dashboards.view", async () => {
    const getOfferEconomicsSnapshot = vi.fn();
    const app = createApp({ getOfferEconomicsSnapshot }, ["accounts.view"]);

    const response = await app.request("/summary");

    expect(response.status).toBe(403);
    expect(getOfferEconomicsSnapshot).not.toHaveBeenCalled();
  });
});
