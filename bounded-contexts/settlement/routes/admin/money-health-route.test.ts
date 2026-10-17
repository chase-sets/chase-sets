import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { AUTH_ROLE_PERMISSIONS } from "../../../auth/support/auth-support/constants";
import type { SettlementApiEnv } from "../../api";
import { createPayoutRoutes } from "../../features/payouts/api/route";
import type { PayoutServices } from "../../features/payouts/api/runtime";

const { mockCreateSettlementRequestApiClient } = vi.hoisted(() => ({
  mockCreateSettlementRequestApiClient: vi.fn(),
}));

vi.mock("../../support/request-support/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../support/request-support/api-client")>(
    "../../support/request-support/api-client",
  );

  return {
    ...actual,
    createSettlementRequestApiClient: mockCreateSettlementRequestApiClient,
  };
});

import { loader as moneyHealthLoader } from "./money-health";
import contextManifest from "../../context.json";

describe("settlement admin money health route", () => {
  const originalMarketplaceOrigin = process.env.CHASE_SETS_MARKETPLACE_ORIGIN;

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    process.env.CHASE_SETS_MARKETPLACE_ORIGIN = originalMarketplaceOrigin;
  });

  it.each(["platform-admin", "owner"] as const)(
    "loads populated and empty Money Health through real %s grants",
    async (roleKey) => {
      const actual = await vi.importActual<typeof import("../../support/request-support/api-client")>(
        "../../support/request-support/api-client",
      );
      mockCreateSettlementRequestApiClient.mockImplementation(actual.createSettlementRequestApiClient);
      vi.stubEnv("CHASE_SETS_INTERNAL_API_ORIGIN", "http://internal.test");
      for (const empty of [false, true]) {
        const rows = empty
          ? []
          : [
              { payout_id: "pyo_a", account_id: "acc_a" },
              { payout_id: "pyo_b", account_id: "acc_b" },
            ];
        const runs = empty ? [] : [{ run_id: "run_a" }, { run_id: "run_b" }];
        const balances = empty ? [] : [{ account_id: "acc_a" }, { account_id: "acc_b" }];
        const forecast = {
          currency_code: "usd",
          available_amount: "200.00",
          pending_payout_demand_amount: "50.00",
          forecast_after_pending_demand_amount: "150.00",
        };
        const provider = { provider_name: "fake", adapter_mode: "fake" };
        const listPayoutsNeedingReconciliation = vi.fn(async ({ accountId }: { accountId: string | null }) =>
          rows.filter((row) => accountId === null || accountId === row.account_id),
        );
        const app = new Hono<SettlementApiEnv>();
        app.use("*", async (c, next) => {
          c.set("actor", {
            sessionId: "ses_test",
            tenantId: "tnt_test",
            userId: "usr_test",
            accountId: "acc_a",
            membershipId: "mem_test",
            roleKey,
            permissions: AUTH_ROLE_PERMISSIONS[roleKey],
          });
          await next();
        });
        app.route(
          "/api/settlement",
          createPayoutRoutes({
            listPayoutsNeedingReconciliation,
            listReconciliationRuns: async () => runs,
            getPlatformBalanceForecast: async () => forecast,
            getProviderHealth: async () => provider,
            listNegativeBalanceAccounts: async () => ({ items: balances, total: balances.length }),
          } as unknown as PayoutServices),
        );
        const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init));
        vi.stubGlobal("fetch", fetch);
        const result = await moneyHealthLoader({
          request: new Request("https://admin.test/commerce/money-health"),
          params: {},
          context: undefined,
        } as never);
        expect(result).toMatchObject({
          payouts_needing_attention: roleKey === "platform-admin" || empty ? rows : [rows[0]],
          reconciliation_runs: runs,
          platform_balance_forecast: forecast,
          provider_health: provider,
          negative_balance_accounts: balances,
          negative_balance_total: balances.length,
        });
        expect(listPayoutsNeedingReconciliation).toHaveBeenCalledExactlyOnceWith({
          accountId: roleKey === "platform-admin" ? null : "acc_a",
          limit: 25,
        });
        expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
          "/api/settlement/money-health",
        ]);
      }
    },
  );

  it.each([401, 403, 503])("propagates Money Health failure %s without inventing a snapshot", async (status) => {
    const actual = await vi.importActual<typeof import("../../support/request-support/api-client")>(
      "../../support/request-support/api-client",
    );
    mockCreateSettlementRequestApiClient.mockImplementation(actual.createSettlementRequestApiClient);
    vi.stubEnv("CHASE_SETS_INTERNAL_API_ORIGIN", "http://internal.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { code: "unavailable", message: "Unavailable" } }, { status })),
    );
    await expect(
      moneyHealthLoader({
        request: new Request("https://admin.test/commerce/money-health"),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status });
  });

  it("loads the money health snapshot and resolves the configured marketplace origin", async () => {
    process.env.CHASE_SETS_MARKETPLACE_ORIGIN = "https://marketplace.chasesets.com";
    const getMoneyHealth = vi.fn(async () => ({
      payouts_needing_attention: [],
      negative_balance_accounts: [],
      negative_balance_total: 0,
      reconciliation_runs: [],
      platform_balance_forecast: {
        currency_code: "usd",
        available_amount: "0.00",
        pending_payout_demand_amount: "0.00",
        forecast_after_pending_demand_amount: "0.00",
      },
      provider_health: {
        provider_name: "fake",
        adapter_mode: "fake",
        webhook_signature_required: false,
        platform_balance_supported: true,
        connected_account_payouts_supported: true,
      },
    }));
    mockCreateSettlementRequestApiClient.mockReturnValue({ getMoneyHealth });

    const result = await moneyHealthLoader({
      request: new Request("https://admin.chasesets.com/commerce/money-health"),
      params: {},
      context: undefined,
    } as never);

    expect(getMoneyHealth).toHaveBeenCalled();
    expect(result).toMatchObject({ marketplaceOrigin: "https://marketplace.chasesets.com" });
  });

  it("resolves a null marketplace origin when unconfigured", async () => {
    delete process.env.CHASE_SETS_MARKETPLACE_ORIGIN;
    mockCreateSettlementRequestApiClient.mockReturnValue({
      getMoneyHealth: vi.fn(async () => ({
        payouts_needing_attention: [],
        negative_balance_accounts: [],
        negative_balance_total: 0,
        reconciliation_runs: [],
        platform_balance_forecast: {
          currency_code: "usd",
          available_amount: "0.00",
          pending_payout_demand_amount: "0.00",
          forecast_after_pending_demand_amount: "0.00",
        },
        provider_health: {
          provider_name: "fake",
          adapter_mode: "fake",
          webhook_signature_required: false,
          platform_balance_supported: true,
          connected_account_payouts_supported: true,
        },
      })),
    });

    const result = await moneyHealthLoader({
      request: new Request("https://admin.chasesets.com/commerce/money-health"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({ marketplaceOrigin: null });
  });

  it("contributes the money health route to admin-web commerce", () => {
    const adminContributions = contextManifest.deployableContributions.find(
      (contribution) => contribution.deployable === "admin-web",
    );

    expect(adminContributions?.routes).toContainEqual({
      routeId: "settlement-money-health",
      routePath: "money-health",
      fileExport: "./routes/admin/money-health",
      routeType: "route",
      sourceContext: "settlement",
      section: "commerce",
    });
  });

  it("no longer contributes money health to marketplace-web", () => {
    const marketplaceContributions = contextManifest.deployableContributions.find(
      (contribution) => contribution.deployable === "marketplace-web",
    );

    expect(marketplaceContributions?.routes.some((route) => route.routeId === "account-money-health")).toBe(false);
  });
});
