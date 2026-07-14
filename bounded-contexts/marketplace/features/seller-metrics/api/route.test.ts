import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { SellerMetricsApiEnv } from "./http";
import { createAccountSellerMetricsRoutes, createPublicSellerMetricsRoutes } from "./route";
import type { SellerMetricsServices } from "./runtime";

function buildApp(
  options: Readonly<{
    actor: SellerMetricsApiEnv["Variables"]["actor"];
    services: SellerMetricsServices;
  }>,
) {
  const app = new Hono<SellerMetricsApiEnv>();

  app.use("*", async (c, next) => {
    c.set("actor", options.actor);
    await next();
  });

  app.route("/account/seller-metrics", createAccountSellerMetricsRoutes(options.services));
  app.route("/accounts", createPublicSellerMetricsRoutes(options.services));

  return app;
}

function createServices(overrides: Partial<SellerMetricsServices> = {}): SellerMetricsServices {
  return {
    getOwnBehavioralMetrics: vi.fn(async () => null),
    getPublicBehavioralMetricsChips: vi.fn(async () => ({
      sellerAccountId: "acc_seller",
      shipsOnTime: true,
      lowCancellationRate: true,
      lowDisputeRate: null,
    })),
    isBuyerFacingChipsEnabled: vi.fn(async () => true),
    ...overrides,
  };
}

describe("marketplace seller-metrics API routes", () => {
  it("requires authentication for the own-account seller dashboard read", async () => {
    const services = createServices();
    const app = buildApp({ actor: null, services });

    const response = await app.request("/account/seller-metrics");
    expect(response.status).toBe(401);
    expect(services.getOwnBehavioralMetrics).not.toHaveBeenCalled();
  });

  it("requires the listings.view permission for the own-account seller dashboard read", async () => {
    const services = createServices();
    const app = buildApp({
      actor: { accountId: "acc_seller", userId: "usr_1", permissions: ["reputation.view"] } as never,
      services,
    });

    const response = await app.request("/account/seller-metrics");
    expect(response.status).toBe(403);
  });

  it("returns the caller's own behavioral metrics, never accepting an accountId param", async () => {
    const services = createServices({
      getOwnBehavioralMetrics: vi.fn(async (sellerAccountId: string) => ({
        seller_account_id: sellerAccountId,
        window_days: 90,
        orders_created_count: 20,
        seller_cancelled_count: 1,
        cancellation_rate: "0.0500",
        shipments_dispatched_count: 18,
        shipments_on_time_count: 17,
        on_time_shipment_rate: "0.9444",
        disputes_resolved_count: 2,
        disputes_against_seller_count: 0,
        dispute_rate: "0.0000",
        missing_responsibility_count: 0,
        computed_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
      })),
    });
    const app = buildApp({
      actor: { accountId: "acc_seller", userId: "usr_1", permissions: ["listings.view"] } as never,
      services,
    });

    const response = await app.request("/account/seller-metrics");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.seller_account_id).toBe("acc_seller");
    expect(services.getOwnBehavioralMetrics).toHaveBeenCalledWith("acc_seller");
  });

  it("returns all-null chips (not the rate-derived booleans) when the rollout gate is off", async () => {
    const services = createServices({ isBuyerFacingChipsEnabled: vi.fn(async () => false) });
    const app = buildApp({ actor: null, services });

    const response = await app.request("/accounts/acc_seller/behavioral-metrics-chips");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      sellerAccountId: "acc_seller",
      shipsOnTime: null,
      lowCancellationRate: null,
      lowDisputeRate: null,
    });
    expect(services.getPublicBehavioralMetricsChips).not.toHaveBeenCalled();
  });

  it("returns chips for any caller (no auth required) once the rollout gate is on", async () => {
    const services = createServices();
    const app = buildApp({ actor: null, services });

    const response = await app.request("/accounts/acc_seller/behavioral-metrics-chips");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      sellerAccountId: "acc_seller",
      shipsOnTime: true,
      lowCancellationRate: true,
      lowDisputeRate: null,
    });
  });
});
