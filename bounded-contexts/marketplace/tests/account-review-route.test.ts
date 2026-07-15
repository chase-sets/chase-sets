import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendFreshWriteToken,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
} from "@chase-sets/http/responses";
import { action as reviewAction, loader as reviewLoader } from "../routes/marketplace/account-review";
import { jsonResponse, requestUrl } from "./test-support/http";

const actor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["reputation.view", "reputation.manage"],
};

const review = {
  review_id: "rev_1",
  order_id: "ord_1",
  author_account_id: "acc_1",
  author_display_name: "Buyer",
  author_role: "buyer",
  subject_account_id: "acc_seller",
  subject_display_name: "Seller",
  rating: 5,
  feedback: "Great seller.",
  status: "submitted",
  created_at: "2026-04-17T00:00:00.000Z",
  updated_at: "2026-04-17T00:00:00.000Z",
};

function marketplaceCommit(position = "44", eventId = "evt_review_submitted") {
  return {
    mode: "eventual",
    commitPosition: position,
    commitEventIds: [eventId],
    commitPositions: [
      {
        sourceContextName: "marketplace",
        maxGlobalPosition: position,
        eventIds: [eventId],
      },
    ],
  };
}

function freshReviewPath(nowMs = Date.now()) {
  return appendFreshWriteToken("/account/reviews/rev_1", marketplaceCommit(), nowMs);
}

describe("marketplace account review route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns route-owned recovery when a fresh review read hits projection freshness timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor }));
        }

        if (url.includes("/api/marketplace/reviews/rev_1")) {
          return Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: "projection_freshness_timeout",
                  message: "Projection read model did not catch up before the freshness timeout.",
                },
              },
              503,
            ),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const result = await reviewLoader({
      request: new Request(`http://localhost${freshReviewPath()}`),
      params: { reviewId: "rev_1" },
      context: undefined,
    } as never);

    expect(result).toEqual({
      review: null,
      viewerAccountId: "acc_1",
      recovery: "fresh-write-preparing",
    });
  });

  it("surfaces expired fresh-write not-found review reads as normal not found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor }));
        }

        if (url.includes("/api/marketplace/reviews/rev_1")) {
          return Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: "not_found",
                  message: "Review not found.",
                },
              },
              404,
            ),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    let response: Response | null = null;
    try {
      await reviewLoader({
        request: new Request(`http://localhost${freshReviewPath(1)}`),
        params: { reviewId: "rev_1" },
        context: undefined,
      } as never);
    } catch (error) {
      response = error as Response;
    }

    expect(response?.status).toBe(404);
    await expect(response?.text()).resolves.toContain("Review not found");
  });

  it("forwards afterWrite metadata when loading a freshly submitted review", async () => {
    const reviewHeaders: Headers[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor }));
        }

        if (url.includes("/api/marketplace/reviews/rev_1")) {
          reviewHeaders.push(new Headers(init?.headers));
          return Promise.resolve(jsonResponse(review));
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const result = await reviewLoader({
      request: new Request(`http://localhost${freshReviewPath()}`),
      params: { reviewId: "rev_1" },
      context: undefined,
    } as never);

    expect(result.review).toMatchObject({ review_id: "rev_1" });
    expect(result.viewerAccountId).toBe("acc_1");
    expect(reviewHeaders[0]?.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(reviewHeaders[0]?.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("marketplace");
  });

  describe("subject reply action (m108)", () => {
    function replyFormRequest(feedback: string) {
      const body = new URLSearchParams({ intent: "reply", feedback });
      return new Request("http://localhost/account/reviews/rev_1", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    }

    it("posts the reply to the API and redirects back to the review with a fresh-write receipt", async () => {
      const replyBodies: unknown[] = [];

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = requestUrl(input);

          if (url.includes("/api/auth/session")) {
            return jsonResponse({ actor });
          }

          if (url.includes("/api/marketplace/reviews/rev_1/reply")) {
            const request = input instanceof Request ? input : new Request(url, init);
            replyBodies.push(await request.clone().json());
            return jsonResponse({ id: "rev_1", replyId: "rvr_1", version: 3, status: "submitted" }, 201);
          }

          return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
        }),
      );

      const result = await reviewAction({
        request: replyFormRequest("Thanks for the feedback -- glad it arrived safely."),
        params: { reviewId: "rev_1" },
        context: undefined,
      } as never);

      expect(replyBodies).toEqual([{ feedback: "Thanks for the feedback -- glad it arrived safely." }]);
      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBeGreaterThanOrEqual(300);
      expect(response.status).toBeLessThan(400);
      expect(response.headers.get("location")).toContain("/account/reviews/rev_1");
    });

    it("returns the API validation error and the draft response when a reply already exists", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const url = requestUrl(input);

          if (url.includes("/api/auth/session")) {
            return jsonResponse({ actor });
          }

          if (url.includes("/api/marketplace/reviews/rev_1/reply")) {
            return jsonResponse(
              {
                error: {
                  code: "validation_failed",
                  message: "A reply already exists for this review.",
                },
              },
              400,
            );
          }

          return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
        }),
      );

      const result = await reviewAction({
        request: replyFormRequest("Second reply attempt."),
        params: { reviewId: "rev_1" },
        context: undefined,
      } as never);

      expect(result).toEqual({
        error: "A reply already exists for this review.",
        values: { feedback: "Second reply attempt." },
      });
    });
  });

  describe("customer review report action", () => {
    function reportFormRequest() {
      return new Request("http://localhost/account/reviews/rev_1", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          intent: "report-review",
          reviewId: "rev_1",
          reason: "harassment-or-abuse",
          details: "This contains abusive language.",
        }),
      });
    }

    it("routes a structured report through Marketplace moderation and returns submission status", async () => {
      const reportBodies: unknown[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = requestUrl(input);
          if (url.includes("/api/auth/session")) {
            return jsonResponse({ actor });
          }
          if (url.includes("/api/marketplace/reviews/rev_1/report")) {
            const request = input instanceof Request ? input : new Request(url, init);
            reportBodies.push(await request.clone().json());
            return jsonResponse(
              { id: "rpt_1", version: 1, status: "submitted", targetType: "review", targetId: "rev_1" },
              201,
            );
          }
          return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
        }),
      );

      const result = await reviewAction({
        request: reportFormRequest(),
        params: { reviewId: "rev_1" },
        context: undefined,
      } as never);

      expect(result).toEqual({ reviewId: "rev_1", status: "submitted" });
      expect(reportBodies).toEqual([
        {
          reason: "harassment-or-abuse",
          details: "This contains abusive language.",
          sourceRoutePath: "/account/reviews/rev_1",
        },
      ]);
    });

    it("returns an explicit duplicate status for an account that already reported the review", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const url = requestUrl(input);
          if (url.includes("/api/auth/session")) {
            return jsonResponse({ actor });
          }
          if (url.includes("/api/marketplace/reviews/rev_1/report")) {
            return jsonResponse(
              {
                error: {
                  code: "report_already_submitted",
                  message: "This reporter has already reported this content.",
                },
              },
              409,
            );
          }
          return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
        }),
      );

      const result = await reviewAction({
        request: reportFormRequest(),
        params: { reviewId: "rev_1" },
        context: undefined,
      } as never);

      expect(result).toEqual({ reviewId: "rev_1", status: "already-submitted" });
    });
  });
});
