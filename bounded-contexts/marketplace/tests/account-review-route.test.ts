import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendFreshWriteToken,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
} from "@chase-sets/http/responses";
import { loader as reviewLoader } from "../routes/marketplace/account-review";
import { jsonResponse, requestUrl } from "./test-support/http";

const actor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["reputation.view"],
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
    expect(reviewHeaders[0]?.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(reviewHeaders[0]?.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("marketplace");
  });
});
