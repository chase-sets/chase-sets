import { resolveActorFromSessionId } from "@chase-sets/auth/server";
import { resolveWebHostNavItems } from "@chase-sets/platform-runtime/web";
import pricingManifest from "../context.json";
import { afterEach, describe, expect, it, vi } from "vitest";
import { action as repricingAction, loader as repricingLoader } from "../routes/marketplace/account-repricing";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("marketplace repricing route", () => {
  it("redirects a missing actor without reading or mutating pricing", async () => {
    const fetch = vi.fn(async () => jsonResponse({}, 401));
    vi.stubGlobal("fetch", fetch);
    for (const method of ["GET", "POST"]) {
      const body = new FormData();
      body.set("intent", "refresh-recommendations");
      const args = {
        request: new Request("https://marketplace.test/account/repricing", {
          method,
          ...(method === "POST" ? { body } : {}),
        }),
        params: {},
        context: undefined,
      } as never;
      await expect(method === "GET" ? repricingLoader(args) : repricingAction(args)).rejects.toMatchObject({
        status: 302,
      });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const slot of ["top-nav", "bottom-nav"] as const) {
      expect(
        resolveWebHostNavItems(
          [
            {
              contextName: "pricing",
              packageName: "@chase-sets/pricing",
              manifest: pricingManifest as Parameters<typeof resolveWebHostNavItems>[0][number]["manifest"],
            },
          ],
          "marketplace-web",
          slot,
        ),
      ).toEqual([]);
    }
  });
  it.each(["owner", "manager", "fulfillment", "viewer", "platform-admin"])(
    "authorizes account repricing with current role presets: %s",
    async (roleKey) => {
      for (const verified of [true, false]) {
        const actor = await resolvePricingActor(roleKey, verified);
        const fetch = vi.fn(async (input: string | URL | Request) => {
          if (String(input).includes("/api/auth/session")) return jsonResponse({ actor });
          return jsonResponse({ items: [], total: 0, count: 0, jobId: "job_synthetic_pricing" });
        });
        vi.stubGlobal("fetch", fetch);
        const args = {
          request: new Request("https://marketplace.test/account/repricing"),
          params: {},
          context: undefined,
        } as never;
        if (roleKey === "platform-admin") {
          await expect(repricingLoader(args)).rejects.toMatchObject({ status: 403 });
        } else {
          await expect(repricingLoader(args)).resolves.toMatchObject({ recommendations: { items: [] } });
        }
        for (const slot of ["top-nav", "bottom-nav"] as const) {
          const items = resolveWebHostNavItems(
            [
              {
                contextName: "pricing",
                packageName: "@chase-sets/pricing",
                manifest: pricingManifest as Parameters<typeof resolveWebHostNavItems>[0][number]["manifest"],
              },
            ],
            "marketplace-web",
            slot,
            actor,
          );
          expect(items.some((item) => item.href === "/account/repricing")).toBe(roleKey !== "platform-admin");
        }
        fetch.mockClear();
        const body = new FormData();
        body.set("intent", "refresh-recommendations");
        const action = repricingAction({
          request: new Request("https://marketplace.test/account/repricing", { method: "POST", body }),
          params: {},
          context: undefined,
        } as never);
        if (verified && ["owner", "manager"].includes(roleKey)) {
          await expect(action).resolves.toMatchObject({ status: 302 });
          expect(fetch.mock.calls.some(([url]) => String(url).includes("/recommendations/refresh"))).toBe(true);
        } else {
          await expect(action).rejects.toMatchObject({ status: 403 });
          expect(fetch.mock.calls.every(([url]) => String(url).includes("/api/auth/session"))).toBe(true);
        }
      }
    },
  );
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

async function resolvePricingActor(roleKey: string, verified = true, accountId = "acc_synthetic_pricing") {
  const services = {
    sessions: {
      readAuthenticatedSession: vi.fn(async () => ({
        state: {
          id: "ses_synthetic_pricing",
          userId: "usr_synthetic_pricing",
          accountId,
          availableAccountIds: [accountId],
          authenticationMethod: "password",
          status: "active",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        authenticatedAt: "2026-09-01T00:00:00.000Z",
      })),
      getSession: vi.fn(async () => null),
    },
    identity: {
      getActiveMembershipForUserAccount: vi.fn(async () => ({
        membership_id: "mbr_synthetic_pricing",
        user_id: "usr_synthetic_pricing",
        account_id: accountId,
        role_key: roleKey,
        role_permissions: [],
        status: "active",
      })),
      getUser: vi.fn(async () => ({
        primary_email: "synthetic-pricing@example.test",
        contact_methods: [
          {
            type: "email",
            value: "synthetic-pricing@example.test",
            verifiedAt: verified ? "2026-09-01T00:00:00.000Z" : null,
          },
        ],
        social_login_links: [],
      })),
    },
  } as unknown as Parameters<typeof resolveActorFromSessionId>[0];
  const actor = await resolveActorFromSessionId(services, "ses_synthetic_pricing");
  expect(actor).not.toBeNull();
  return actor!;
}
