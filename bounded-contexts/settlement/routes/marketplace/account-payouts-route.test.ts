import { afterEach, describe, expect, it, vi } from "vitest";
import { readFreshWriteToken } from "@chase-sets/http/responses";

const { mockCreateSettlementRequestApiClient, mockRequireActorFromAuthApi, mockResolveRequiredActorFromAuthApi } =
  vi.hoisted(() => ({
    mockCreateSettlementRequestApiClient: vi.fn(),
    mockRequireActorFromAuthApi: vi.fn(),
    mockResolveRequiredActorFromAuthApi: vi.fn(),
  }));

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );

  return {
    ...actual,
    requireActorFromAuthApi: mockRequireActorFromAuthApi,
    resolveRequiredActorFromAuthApi: mockResolveRequiredActorFromAuthApi,
  };
});

vi.mock("../../support/request-support/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../support/request-support/api-client")>(
    "../../support/request-support/api-client",
  );

  return {
    ...actual,
    createSettlementRequestApiClient: mockCreateSettlementRequestApiClient,
  };
});

import { action as accountPayoutsAction, headers, loader as accountPayoutsLoader } from "./account-payouts";

function settlementActor(permissions: readonly string[]) {
  return {
    accountId: "acc_seller",
    permissions,
  };
}

function formRequest(form: URLSearchParams) {
  return new Request("http://localhost/account/payouts", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

describe("settlement account payouts route action", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("sets the Stripe Connect CSP for the notification banner", () => {
    expect(headers()["Content-Security-Policy"]).toContain(
      "script-src 'self' 'unsafe-inline' https://connect-js.stripe.com https://js.stripe.com",
    );
    expect(headers()["Cross-Origin-Opener-Policy"]).toBe("unsafe-none");
  });

  it("returns an account access state instead of throwing 403 for signed-in actors without payout access", async () => {
    mockResolveRequiredActorFromAuthApi.mockResolvedValue({
      kind: "forbidden",
      actor: settlementActor(["accounts.view"]),
      requiredPermission: "payouts.view",
    });
    const walletRead = vi.fn();
    mockCreateSettlementRequestApiClient.mockReturnValue({
      getWallet: walletRead,
      listPayouts: vi.fn(),
      getPayoutReadiness: vi.fn(),
    });

    const result = await accountPayoutsLoader({
      request: new Request("http://localhost/account/payouts"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      accountAccessRequired: {
        returnTo: "/account/payouts",
      },
    });
    expect(walletRead).not.toHaveBeenCalled();
  });

  it("returns an account access state for setup-return refreshes when the signed-in actor lacks setup access", async () => {
    mockResolveRequiredActorFromAuthApi.mockResolvedValue({
      kind: "forbidden",
      actor: settlementActor(["accounts.view"]),
      requiredPermission: "payouts.setup",
    });
    const refreshPayoutSetup = vi.fn();
    mockCreateSettlementRequestApiClient.mockReturnValue({ refreshPayoutSetup });

    const result = await accountPayoutsLoader({
      request: new Request("http://localhost/account/payouts?setup=returned"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      accountAccessRequired: {
        returnTo: "/account/payouts?setup=returned",
      },
    });
    expect(refreshPayoutSetup).not.toHaveBeenCalled();
  });

  it("returns the payout setup readiness snapshot after self-refresh", async () => {
    const refreshPayoutSetup = vi.fn(async () => ({
      account_id: "acc_seller",
      status: "ready",
      missing_requirements: [],
      provider_reference: "acct_test",
      onboarding_status: "complete",
      transfer_capability_status: "active",
      payout_capability_status: "active",
      payout_destination_status: "ready",
      payout_account_dashboard: "none",
      losses_collector: "application",
      fees_collector: "application",
      requirements_collector: "application",
      updated_at: "2026-06-15T20:00:00.000Z",
    }));
    mockRequireActorFromAuthApi.mockResolvedValue(settlementActor(["payouts.view", "payouts.setup"]));
    mockCreateSettlementRequestApiClient.mockReturnValue({ refreshPayoutSetup });
    const form = new URLSearchParams({ intent: "refresh-payout-setup" });

    const result = await accountPayoutsAction({
      request: formRequest(form),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      refreshedPayoutReadiness: {
        account_id: "acc_seller",
        status: "ready",
        provider_reference: "acct_test",
      },
      setupNotice: expect.any(String),
    });
    expect(refreshPayoutSetup).toHaveBeenCalledTimes(1);
  });

  it("redirects confirmed payouts with the original fresh-write receipt", async () => {
    const createPayout = vi.fn(async () => ({
      id: "pyo_test",
      version: 2,
      status: "in-transit",
      commitPosition: "42",
      commitPositions: [
        {
          sourceContextName: "settlement",
          maxGlobalPosition: "42",
          eventIds: ["evt_settlement_payout"],
        },
      ],
    }));
    mockRequireActorFromAuthApi.mockResolvedValue(settlementActor(["payouts.view", "payouts.request"]));
    mockCreateSettlementRequestApiClient.mockReturnValue({ createPayout });
    const form = new URLSearchParams({
      intent: "confirm-payout",
      amount: "12.50",
      note: "Weekly payout",
    });

    const response = (await accountPayoutsAction({
      request: formRequest(form),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/account/payouts/pyo_test?requested=1");
    expect(readFreshWriteToken(response.headers.get("Location") ?? "")).toMatchObject({
      commitPosition: "42",
      sources: [
        {
          sourceContextName: "settlement",
          maxGlobalPosition: "42",
          eventIds: ["evt_settlement_payout"],
        },
      ],
    });
  });

  it.each([
    ["start-payout-setup", "/account/payouts/setup"],
    ["manage-payout-account", "/account/payouts/setup?mode=manage"],
  ])("treats %s as navigation-only setup intent", async (intent, expectedLocation) => {
    const refreshPayoutSetup = vi.fn();
    const createPayout = vi.fn();
    const previewPayout = vi.fn();
    mockRequireActorFromAuthApi.mockResolvedValue(settlementActor(["payouts.view", "payouts.setup"]));
    mockCreateSettlementRequestApiClient.mockReturnValue({
      createPayout,
      previewPayout,
      refreshPayoutSetup,
    });
    const form = new URLSearchParams({ intent });

    const response = (await accountPayoutsAction({
      request: formRequest(form),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(expectedLocation);
    expect(createPayout).not.toHaveBeenCalled();
    expect(previewPayout).not.toHaveBeenCalled();
    expect(refreshPayoutSetup).not.toHaveBeenCalled();
  });
});
