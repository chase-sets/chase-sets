import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PricingApiEnv } from "../../../api";
import { createAccountRecommendationRoutes } from "./route";
import type { PricingRecommendationJobStatus, PricingRecommendationServices } from "./runtime";

function pricingActor(
  overrides: Partial<NonNullable<PricingApiEnv["Variables"]["actor"]>> = {},
): NonNullable<PricingApiEnv["Variables"]["actor"]> {
  return {
    sessionId: "ses_1",
    tenantId: "ten_1",
    userId: "usr_1",
    accountId: "acc_1",
    membershipId: "mbr_1",
    roleKey: "owner",
    permissions: ["pricing.view", "pricing.manage"],
    ...overrides,
  };
}

function pricingContext(): EventStoreContext {
  return {
    tenantId: "ten_1" as never,
    audit: {
      performedByUserId: "usr_1" as never,
      forAccountId: "acc_1" as never,
    },
  };
}

function jobSnapshot(overrides: Partial<PricingRecommendationJobStatus> = {}): PricingRecommendationJobStatus {
  return {
    jobId: "job_1",
    jobKind: "apply",
    status: "queued",
    progress: {
      phase: "queued",
      completed: 0,
      total: 1,
      message: "Recommendation job queued.",
    },
    result: null,
    errorMessage: null,
    createdAt: "2026-05-09T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-05-09T00:00:00.000Z",
    ...overrides,
  };
}

function createServices(): PricingRecommendationServices {
  return {
    publishRecommendation: vi.fn(async () => ({
      recommendationId: "rec_1",
      accountId: "acc_1",
      status: "proposed",
      recommendedListAmount: 16.5,
      recommendationReason: "Command-owned guidance.",
      publishedAt: "2026-05-09T01:00:00.000Z",
      version: 2,
    })),
    enqueueRecommendationJob: vi.fn(async (params) =>
      jobSnapshot({
        jobId: `job_${params.action}`,
        jobKind: params.action,
      } as Partial<PricingRecommendationJobStatus>),
    ),
    listAccountRecommendations: vi.fn(async () => ({ items: [], total: 0 })),
    getAccountRecommendation: vi.fn(async () => null),
    getRecommendationJob: vi.fn(async () => jobSnapshot()),
    listRecommendationJobEvents: vi.fn(async () => []),
    waitForRecommendationJobEvents: vi.fn(async () => undefined),
  } as unknown as PricingRecommendationServices;
}

function buildApp(services = createServices()) {
  const app = new Hono<PricingApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", pricingActor());
    c.set("context", pricingContext());
    await next();
  });
  app.route("/account", createAccountRecommendationRoutes(services));
  return app;
}

describe("pricing recommendation API routes", () => {
  it("returns the command-owned publish snapshot with the write receipt fields", async () => {
    const services = createServices();
    const response = await buildApp(services).fetch(
      new Request("http://pricing.test/account/recommendations/rec_1/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recommendedListAmount: 16.5,
          reason: "Command-owned guidance.",
          publishedAt: "2026-05-09T01:00:00.000Z",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "rec_1",
      version: 2,
      recommendation: {
        recommendationId: "rec_1",
        accountId: "acc_1",
        status: "proposed",
        recommendedListAmount: 16.5,
        recommendationReason: "Command-owned guidance.",
        publishedAt: "2026-05-09T01:00:00.000Z",
        version: 2,
      },
    });
  });

  it.each([
    ["refresh", "/account/recommendations/refresh", {}],
    ["apply", "/account/recommendations/apply", { recommendationIds: ["rec_1"] }],
    ["dismiss", "/account/recommendations/dismiss", { recommendationIds: ["rec_1"] }],
  ])("returns the durable job snapshot for %s writes", async (action, path, body) => {
    const services = createServices();
    const response = await buildApp(services).fetch(
      new Request(`http://pricing.test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: `job_${action}`,
      jobKind: action,
      status: "queued",
      progress: {
        phase: "queued",
        message: "Recommendation job queued.",
      },
    });
  });
});
