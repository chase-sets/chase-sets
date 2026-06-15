import { afterEach, describe, expect, it, vi } from "vitest";
import { action as repricingAction, loader as repricingLoader } from "../routes/marketplace/account-repricing";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("marketplace repricing route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads advisory pricing recommendations through the pricing API", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        requestedUrls.push(url);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["pricing.view"],
              },
            }),
          );
        }

        if (url.includes("/api/platform/release-controls/rollouts/pricing.account-repricing/decision")) {
          return Promise.resolve(
            jsonResponse({
              enabled: true,
              reason: "subject-allowlist",
              bucket: 10,
              featureKey: "pricing.account-repricing",
              environment: "production",
              subject: { subjectType: "account", subjectId: "acc_1" },
              cohortSize: 1,
            }),
          );
        }

        return Promise.resolve(
          jsonResponse({
            items: [
              {
                recommendation_id: "rec_1",
                catalog_catalog_item_id: "cat_1",
                seller_account_id: "acc_1",
                catalog_item_title: "Charizard ex",
                catalog_item_subtitle: null,
                catalog_item_status: "active",
                market_price_amount: 20,
                market_currency: "USD",
                market_observed_at: "2026-05-09T00:00:00.000Z",
                recommended_list_amount: 22,
                recommendation_reason: "Protect margin.",
                recommendation_published_at: null,
                stock_on_hand_quantity: 4,
                stock_reserved_quantity: 1,
                active_listing_count: 3,
                lowest_listing_price_amount: 18,
                active_offer_count: 2,
                highest_offer_price_amount: 19,
                committed_order_quantity: 5,
                delivered_quantity: 4,
                returned_quantity: 1,
                updated_at: "2026-05-09T00:02:00.000Z",
              },
            ],
            total: 1,
            count: 1,
          }),
        );
      }),
    );

    const result = await repricingLoader({
      request: new Request("http://localhost/account/repricing"),
      params: {},
      context: undefined,
    } as never);

    expect(result.recommendations.items[0]?.recommendation_id).toBe("rec_1");
    expect(
      requestedUrls.some((url) =>
        url.includes("/api/platform/release-controls/rollouts/pricing.account-repricing/decision"),
      ),
    ).toBe(true);
    expect(requestedUrls.some((url) => url.includes("/api/marketplace/account/recommendations"))).toBe(true);
  });

  it("hydrates the active recommendation job snapshot after a write redirect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["pricing.view"],
              },
            }),
          );
        }

        if (url.includes("/api/platform/release-controls/rollouts/pricing.account-repricing/decision")) {
          return Promise.resolve(
            jsonResponse({
              enabled: true,
              reason: "subject-allowlist",
              bucket: 10,
              featureKey: "pricing.account-repricing",
              environment: "production",
              subject: { subjectType: "account", subjectId: "acc_1" },
              cohortSize: 1,
            }),
          );
        }

        if (url.includes("/api/marketplace/account/recommendation-jobs/job_apply")) {
          return Promise.resolve(
            jsonResponse({
              jobId: "job_apply",
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
            }),
          );
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const result = await repricingLoader({
      request: new Request("http://localhost/account/repricing?jobId=job_apply"),
      params: {},
      context: undefined,
    } as never);

    expect(result.activeJob).toMatchObject({
      jobId: "job_apply",
      status: "queued",
      progress: {
        message: "Recommendation job queued.",
      },
    });
  });

  it("redirects apply writes to a job snapshot correction route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["pricing.view", "pricing.manage"],
              },
            }),
          );
        }

        if (url.includes("/api/platform/release-controls/rollouts/pricing.account-repricing/decision")) {
          return Promise.resolve(
            jsonResponse({
              enabled: true,
              reason: "subject-allowlist",
              bucket: 10,
              featureKey: "pricing.account-repricing",
              environment: "production",
              subject: { subjectType: "account", subjectId: "acc_1" },
              cohortSize: 1,
            }),
          );
        }

        return Promise.resolve(
          jsonResponse({
            jobId: "job_apply",
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
          }),
        );
      }),
    );

    const form = new FormData();
    form.set("intent", "apply-recommendations");
    form.append("recommendationId", "rec_1");
    const response = await repricingAction({
      request: new Request("http://localhost/account/repricing", {
        method: "POST",
        body: form,
      }),
      params: {},
      context: undefined,
    } as never);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("Location")).toBe("/account/repricing?jobId=job_apply");
  });
});
