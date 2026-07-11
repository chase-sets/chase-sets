import { afterEach, describe, expect, it, vi } from "vitest";

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
    process.env.CHASE_SETS_MARKETPLACE_ORIGIN = originalMarketplaceOrigin;
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
