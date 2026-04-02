import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ReputationApiEnv } from "../api";
import {
  createAccountReviewRoutes,
  createPublicReputationRoutes,
} from "./route";
import type { ReputationReviewServices } from "./runtime";

function buildApp(options: Readonly<{
  actor: ReputationApiEnv["Variables"]["actor"];
  services: ReputationReviewServices;
}>) {
  const app = new Hono<ReputationApiEnv>();

  app.use("*", async (c, next) => {
    c.set("actor", options.actor);
    c.set(
      "context",
      options.actor
        ? {
            tenantId: "tnt_identity" as never,
            audit: {
              performedByUserId: options.actor.userId as never,
              forAccountId: options.actor.accountId as never,
            },
          }
        : null,
    );
    await next();
  });

  app.route("/reviews", createAccountReviewRoutes(options.services));
  app.route("/accounts", createPublicReputationRoutes(options.services));

  return app;
}

function createServices(): ReputationReviewServices {
  return {
    commandHandler: vi.fn(async () => ({
      state: {} as never,
      version: 1,
      newEvents: [],
      storedEvents: [],
    })),
    submitReview: vi.fn(async () => ({ reviewId: "rev_1", version: 1 })),
    updateReview: vi.fn(async () => ({ reviewId: "rev_1", version: 2 })),
    withdrawReview: vi.fn(async () => ({ reviewId: "rev_1", version: 3 })),
    listPublicAccountReviews: vi.fn(async () => ({ items: [], total: 0 })),
    listWrittenReviews: vi.fn(async () => ({ items: [], total: 0 })),
    listReceivedReviews: vi.fn(async () => ({ items: [], total: 0 })),
    getOrderReviewOpportunity: vi.fn(async () => null),
    getAccountReview: vi.fn(async () => null),
    getPublicAccountSummary: vi.fn(async () => ({
      account_id: "acc_seller",
      account_display_name: "Seller",
      average_rating: "4.50",
      review_count: 10,
      rating_1_count: 0,
      rating_2_count: 1,
      rating_3_count: 1,
      rating_4_count: 3,
      rating_5_count: 5,
      updated_at: "2026-04-02T00:00:00.000Z",
    })),
    projectors: [],
  };
}

describe("reputation review routes", () => {
  it("lists written reviews for the current account", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["reputation.view", "reputation.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://reputation.test/reviews/written"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [],
      total: 0,
      count: 0,
    });
    expect(services.listWrittenReviews).toHaveBeenCalledWith({
      authorAccountId: "acc_buyer",
      limit: 50,
      offset: 0,
    });
  });

  it("returns a review opportunity for a verified order", async () => {
    const services = createServices();
    vi.mocked(services.getOrderReviewOpportunity).mockResolvedValue({
      order_id: "ord_1",
      subject_account_id: "acc_seller",
      subject_display_name: "Seller",
      author_role: "buyer",
      eligible_at: "2026-04-02T00:00:00.000Z",
      active_review_id: null,
    });
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["reputation.view", "reputation.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://reputation.test/reviews/opportunities/orders/ord_1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      order_id: "ord_1",
      subject_account_id: "acc_seller",
      subject_display_name: "Seller",
      author_role: "buyer",
      eligible_at: "2026-04-02T00:00:00.000Z",
      active_review_id: null,
    });
    expect(services.getOrderReviewOpportunity).toHaveBeenCalledWith(
      "ord_1",
      "acc_buyer",
    );
  });

  it("returns 404 when an order is not verified for review", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["reputation.view", "reputation.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://reputation.test/reviews/opportunities/orders/ord_2"),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Review opportunity not found.",
    });
  });

  it("returns public reputation summaries without authentication", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    const response = await app.fetch(
      new Request("http://reputation.test/accounts/acc_seller/reputation"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      account_id: "acc_seller",
      account_display_name: "Seller",
      average_rating: "4.50",
      review_count: 10,
      rating_1_count: 0,
      rating_2_count: 1,
      rating_3_count: 1,
      rating_4_count: 3,
      rating_5_count: 5,
      updated_at: "2026-04-02T00:00:00.000Z",
    });
  });

  it("rejects review submission without reputation manage permission", async () => {
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "viewer",
        permissions: ["reputation.view"],
      },
      services: createServices(),
    });

    const response = await app.fetch(
      new Request("http://reputation.test/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "ord_1",
          subjectAccountId: "acc_seller",
          rating: 5,
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden." });
  });
});
