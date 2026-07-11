import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ReputationApiEnv } from "./http";
import { createAccountReviewRoutes, createPublicReputationRoutes } from "./route";
import type { ReviewServices } from "./runtime";

function buildApp(
  options: Readonly<{
    actor: ReputationApiEnv["Variables"]["actor"];
    services: ReviewServices;
  }>,
) {
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

function createServices(): ReviewServices {
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
    recordDeliveredShipmentReviewEligibility: vi.fn(async () => undefined),
    listPublicAccountReviews: vi.fn(async () => ({ items: [], total: 0 })),
    listWrittenReviews: vi.fn(async () => ({ items: [], total: 0 })),
    listReceivedReviews: vi.fn(async () => ({ items: [], total: 0 })),
    getOrderReviewOpportunity: vi.fn(async () => null),
    getAccountReview: vi.fn(async () => null),
    getPublicAccountSummary: vi.fn(async () => ({
      account_id: "acc_seller",
      account_display_name: "Seller",
      average_rating_as_seller: "4.50",
      review_count_as_seller: 10,
      rating_1_count_as_seller: 0,
      rating_2_count_as_seller: 1,
      rating_3_count_as_seller: 1,
      rating_4_count_as_seller: 3,
      rating_5_count_as_seller: 5,
      average_rating_as_buyer: null,
      review_count_as_buyer: 0,
      rating_1_count_as_buyer: 0,
      rating_2_count_as_buyer: 0,
      rating_3_count_as_buyer: 0,
      rating_4_count_as_buyer: 0,
      rating_5_count_as_buyer: 0,
      updated_at: "2026-04-02T00:00:00.000Z",
    })),
    projectors: [],
  } as unknown as ReviewServices;
}

describe("marketplace review routes", () => {
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

    const response = await app.fetch(new Request("http://reputation.test/reviews/written"));

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
      window_expired: false,
      window_expires_at: "2026-06-01T00:00:00.000Z",
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

    const response = await app.fetch(new Request("http://reputation.test/reviews/opportunities/orders/ord_1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      order_id: "ord_1",
      subject_account_id: "acc_seller",
      subject_display_name: "Seller",
      author_role: "buyer",
      eligible_at: "2026-04-02T00:00:00.000Z",
      active_review_id: null,
      window_expired: false,
      window_expires_at: "2026-06-01T00:00:00.000Z",
    });
    expect(services.getOrderReviewOpportunity).toHaveBeenCalledWith("ord_1", "acc_buyer");
  });

  it("lets a seller submit an account review for the buyer on a verified order", async () => {
    const services = createServices();
    vi.mocked(services.getOrderReviewOpportunity).mockResolvedValue({
      order_id: "ord_1",
      subject_account_id: "acc_buyer",
      subject_display_name: "Buyer",
      author_role: "seller",
      eligible_at: "2026-04-02T00:00:00.000Z",
      active_review_id: null,
      window_expired: false,
      window_expires_at: "2026-06-01T00:00:00.000Z",
    });
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["reputation.view", "reputation.manage"],
      },
      services,
    });

    const opportunityResponse = await app.fetch(
      new Request("http://reputation.test/reviews/opportunities/orders/ord_1"),
    );
    const submitResponse = await app.fetch(
      new Request("http://reputation.test/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "ord_1",
          subjectAccountId: "acc_buyer",
          rating: 4,
          feedback: "Prompt payment and clear communication.",
        }),
      }),
    );

    expect(opportunityResponse.status).toBe(200);
    expect(submitResponse.status).toBe(201);
    await expect(submitResponse.json()).resolves.toEqual({
      id: "rev_1",
      version: 1,
      status: "submitted",
    });
    expect(services.getOrderReviewOpportunity).toHaveBeenCalledWith("ord_1", "acc_seller");
    expect(services.submitReview).toHaveBeenCalledWith(
      {
        orderId: "ord_1",
        authorAccountId: "acc_seller",
        subjectAccountId: "acc_buyer",
        rating: 4,
        feedback: "Prompt payment and clear communication.",
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
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

    const response = await app.fetch(new Request("http://reputation.test/reviews/opportunities/orders/ord_2"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Review opportunity not found.",
      },
    });
  });

  it("returns public review summaries without authentication", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    const response = await app.fetch(new Request("http://reputation.test/accounts/acc_seller/review-summary"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      account_id: "acc_seller",
      account_display_name: "Seller",
      average_rating_as_seller: "4.50",
      review_count_as_seller: 10,
      rating_1_count_as_seller: 0,
      rating_2_count_as_seller: 1,
      rating_3_count_as_seller: 1,
      rating_4_count_as_seller: 3,
      rating_5_count_as_seller: 5,
      average_rating_as_buyer: null,
      review_count_as_buyer: 0,
      rating_1_count_as_buyer: 0,
      rating_2_count_as_buyer: 0,
      rating_3_count_as_buyer: 0,
      rating_4_count_as_buyer: 0,
      rating_5_count_as_buyer: 0,
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
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "authorization_forbidden",
        message: "Forbidden.",
      },
    });
  });

  it("updates and withdraws a written review through documented API actions", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_buyer",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["reputation.view", "reputation.manage"],
      },
      services,
    });

    const updateResponse = await app.fetch(
      new Request("http://reputation.test/reviews/rev_1/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating: 4,
          feedback: "Strong transaction overall.",
        }),
      }),
    );
    const withdrawResponse = await app.fetch(
      new Request("http://reputation.test/reviews/rev_1/withdraw", {
        method: "POST",
      }),
    );

    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toEqual({
      id: "rev_1",
      version: 2,
      status: "updated",
    });
    expect(withdrawResponse.status).toBe(200);
    await expect(withdrawResponse.json()).resolves.toEqual({
      id: "rev_1",
      version: 3,
      status: "withdrawn",
    });
    expect(services.updateReview).toHaveBeenCalledWith(
      {
        reviewId: "rev_1",
        authorAccountId: "acc_buyer",
        rating: 4,
        feedback: "Strong transaction overall.",
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_buyer",
          performedByUserId: "usr_buyer",
        }),
      }),
    );
    expect(services.withdrawReview).toHaveBeenCalledWith(
      {
        reviewId: "rev_1",
        authorAccountId: "acc_buyer",
      },
      expect.any(Object),
    );
  });
});
