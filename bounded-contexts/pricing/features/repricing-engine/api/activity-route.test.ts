import { resolveActorFromSessionId } from "@chase-sets/auth/server";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PricingApiEnv } from "../../../api";
import { createRepricingActivityRoutes } from "./activity-route";
import { repricingActivityFilters } from "./activity";
import type { RepricingPolicyRecord } from "../../repricing-policies/read-model/queries";

function buildApp(
  accountId = "account-a",
  permissions = ["pricing.view"],
  authenticated = true,
  resolvedActor?: NonNullable<Awaited<ReturnType<typeof resolveActorFromSessionId>>>,
) {
  const services: Parameters<typeof createRepricingActivityRoutes>[0] = {
    getAccountRepricingPolicy: vi.fn(
      async (account: string, policyId: string): Promise<RepricingPolicyRecord | null> =>
        policyId === `policy-${account.at(-1)}`
          ? {
              policyId,
              sellerAccountId: account,
              name: "Policy",
              status: "active",
              scope: { kind: "all-listings" },
              excludedListingIds: [],
              rules: [],
              maxChangesPerDay: 10,
              createdAt: "2026-09-16T00:00:00.000Z",
              updatedAt: "2026-09-16T00:00:00.000Z",
            }
          : null,
    ),
    activity: vi.fn(async ({ accountId: account, policyId }) => ({
      rows: [
        {
          listingId: `listing-${account}`,
          evaluationId: "evaluation-a",
          policyId,
          productKey: { catalogItemId: "catalog-a", productId: "product-a" },
          evaluatedAt: "2026-09-16T00:00:00.000Z",
          trace: {
            listingId: `listing-${account}`,
            currentPriceAmount: "10.00",
            targetPriceAmount: "5.00",
            ruleIndex: 0,
            anchor: null,
            exhaustedAnchors: [],
            clamps: { floor: true, ceiling: false, maxMove: false },
            flags: [],
            outcome: "changed" as const,
            skipReason: null,
          },
          floorBindingSince: null,
          frozenUntil: null,
          affectedListingCount: 0,
        },
      ],
      next: null,
      filterCounts: Object.fromEntries(
        repricingActivityFilters.map((key) => [key, key === "changed" ? 1 : 0]),
      ) as Record<(typeof repricingActivityFilters)[number], number>,
    })),
    attention: vi.fn(async (account) => ({
      floorBinding: account === "account-a" ? 1 : 2,
      pausedForMissingInput: 0,
      budgetExhaustedToday: [],
      haltEngaged: false,
      frozenProducts: [],
    })),
  };
  const app = new Hono<PricingApiEnv>();
  app.use("*", async (c, next) => {
    if (authenticated)
      c.set(
        "actor",
        resolvedActor ?? {
          sessionId: "ses_1",
          tenantId: "tnt_identity",
          userId: "usr_7912",
          accountId,
          membershipId: "mbr_1",
          roleKey: "owner",
          permissions,
        },
      );
    return next();
  });
  app.route("/account/repricing-policies", createRepricingActivityRoutes(services));
  return { app, services };
}
const base = "/account/repricing-policies";

describe("repricing activity routes", () => {
  it.each(["owner", "manager", "fulfillment", "viewer", "platform-admin"])(
    "uses resolved pricing presets: %s",
    async (roleKey) => {
      for (const verified of [true, false]) {
        const actor = await resolvePricingActor(roleKey, verified, "acc_synthetic_a");
        const { app } = buildApp(actor.accountId, [], true, actor);
        expect((await app.request(`${base}/policy-a/activity`)).status).toBe(roleKey === "platform-admin" ? 403 : 200);
        expect((await app.request(`${base}/attention-summary`)).status).toBe(roleKey === "platform-admin" ? 403 : 200);
        if (roleKey !== "platform-admin") {
          expect((await app.request(`${base}/policy-b/activity`)).status).toBe(404);
        }
      }
    },
  );
  it("does not impose read authorization on neighboring policy commands", async () => {
    const { app } = buildApp("account-a", ["pricing.manage"]);
    app.post(`${base}/policy-a/revise`, (c) => c.body(null, 204));
    expect((await app.request(`${base}/policy-a/revise`, { method: "POST" })).status).toBe(204);
    expect((await app.request(`${base}/policy-a/activity`)).status).toBe(403);
  });
  it.each(["account-a", "account-b"])("fences policy ownership for %s before rows or counts", async (account) => {
    const { app, services } = buildApp(account);
    const owned = `policy-${account.at(-1)}`;
    const foreign = account === "account-a" ? "policy-b" : "policy-a";
    expect((await app.request(`${base}/${owned}/activity`)).status).toBe(200);
    const before = vi.mocked(services.activity).mock.calls.length;
    const denied = await app.request(`${base}/${foreign}/activity`);
    const absent = await app.request(`${base}/missing/activity`);
    expect(denied.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await denied.json()).toEqual(await absent.json());
    expect(services.activity).toHaveBeenCalledTimes(before);
    expect((await app.request(`${base}/${foreign}/attention-summary`)).status).toBe(404);
    const attention = await app.request(`${base}/attention-summary`);
    expect(await attention.json()).toMatchObject({ floorBinding: account === "account-a" ? 1 : 2 });
    expect(services.attention).toHaveBeenCalledWith(account, expect.any(String));
  });
  it("keeps the declared page bound and filter registry", async () => {
    const { app, services } = buildApp();
    for (const filter of repricingActivityFilters) {
      expect((await app.request(`${base}/policy-a/activity?filter=${filter}&limit=50&after=listing-a`)).status).toBe(
        200,
      );
      expect(services.activity).toHaveBeenLastCalledWith(
        expect.objectContaining({ filter, limit: 50, after: "listing-a" }),
      );
    }
    for (const query of [
      "limit=51",
      "limit=0",
      "limit=-1",
      "limit=1.5",
      "limit=NaN",
      "filter=unknown",
      "after=",
      "accountId=account-b",
    ]) {
      expect((await app.request(`${base}/policy-a/activity?${query}`)).status).toBe(400);
    }
    expect((await app.request(`${base}/attention-summary?accountId=account-b`)).status).toBe(400);
  });
  it.each(["/policy-a/activity", "/attention-summary"])("requires authentication and permission: %s", async (path) => {
    expect((await buildApp("account-a", [], false).app.request(base + path)).status).toBe(401);
    expect((await buildApp("account-a", []).app.request(base + path)).status).toBe(403);
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
