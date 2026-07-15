import { afterEach, describe, expect, it, vi } from "vitest";
import { readFreshWriteToken } from "@chase-sets/http/responses";

const { mockCreateSettlementRequestApiClient, mockRequireActorFromAuthApi } = vi.hoisted(() => ({
  mockCreateSettlementRequestApiClient: vi.fn(),
  mockRequireActorFromAuthApi: vi.fn(),
}));

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );
  return { ...actual, requireActorFromAuthApi: mockRequireActorFromAuthApi };
});

vi.mock("../../support/request-support/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../support/request-support/api-client")>(
    "../../support/request-support/api-client",
  );
  return { ...actual, createSettlementRequestApiClient: mockCreateSettlementRequestApiClient };
});

import { action, headers, loader } from "./account-desk-money";
import { loader as legacyPayoutsLoader } from "./account-payouts";
import { loader as legacySettlementLoader } from "./account-settlement";
import { loader as legacyWalletAdjustmentLoader } from "./account-wallet-adjustment";

function actor(permissions: readonly string[]) {
  return { accountId: "acc_seller", permissions };
}

function formRequest(form: URLSearchParams) {
  return new Request("http://localhost/account/desk/money", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

describe("Seller Desk money route", () => {
  afterEach(() => vi.resetAllMocks());

  it("loads wallet, ledger, payouts, and readiness from the owning context", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue(
      actor(["payouts.view", "payouts.request", "payouts.setup", "payouts.reconcile"]),
    );
    const api = {
      getWallet: vi.fn(async () => ({ account_id: "acc_seller" })),
      listWalletEntries: vi.fn(async () => ({ items: [], total: 0 })),
      listPayouts: vi.fn(async () => ({ items: [], total: 0 })),
      getPayoutReadiness: vi.fn(async () => ({ account_id: "acc_seller", status: "ready" })),
    };
    mockCreateSettlementRequestApiClient.mockReturnValue(api);

    const result = await loader({
      request: new Request("http://localhost/account/desk/money"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      canRequestPayouts: true,
      canSetupPayouts: true,
      canReconcilePayouts: true,
      wallet: { account_id: "acc_seller" },
      entries: { items: [] },
      payouts: { items: [] },
      payoutReadiness: { status: "ready" },
    });
    expect(api.getWallet).toHaveBeenCalledOnce();
    expect(api.listWalletEntries).toHaveBeenCalledOnce();
    expect(api.listPayouts).toHaveBeenCalledOnce();
    expect(api.getPayoutReadiness).toHaveBeenCalledOnce();
  });

  it("sets the Stripe Connect CSP for payout account notifications", () => {
    expect(headers()["Content-Security-Policy"]).toContain("https://connect-js.stripe.com");
  });

  it("redirects confirmed payouts to the re-homed entity with the fresh-write receipt", async () => {
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
    mockRequireActorFromAuthApi.mockResolvedValue(actor(["payouts.view", "payouts.request"]));
    mockCreateSettlementRequestApiClient.mockReturnValue({ createPayout });

    const response = (await action({
      request: formRequest(new URLSearchParams({ intent: "confirm-payout", amount: "12.50", note: "Weekly payout" })),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/account/desk/payouts/pyo_test?requested=1");
    expect(readFreshWriteToken(response.headers.get("Location") ?? "")).toMatchObject({
      commitPosition: "42",
      sources: [{ sourceContextName: "settlement", maxGlobalPosition: "42" }],
    });
  });

  it("returns the authoritative payout preview on the dashboard", async () => {
    const previewPayout = vi.fn(async () => ({
      can_request: true,
      estimated_wallet_balance_after: "87.50",
      unavailable_reason_details: [],
    }));
    mockRequireActorFromAuthApi.mockResolvedValue(actor(["payouts.view", "payouts.request"]));
    mockCreateSettlementRequestApiClient.mockReturnValue({ previewPayout });

    const result = await action({
      request: formRequest(new URLSearchParams({ intent: "preview-payout", amount: "12.50" })),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      confirmation: {
        amount: "12.50",
        preview: { can_request: true, estimated_wallet_balance_after: "87.50" },
      },
    });
  });

  it("queues the settlement reconciliation workflow for a retry action", async () => {
    const runPayoutReconciliation = vi.fn(async () => ({ progress: { message: "Payout retry queued." } }));
    mockRequireActorFromAuthApi.mockResolvedValue(actor(["payouts.view", "payouts.reconcile"]));
    mockCreateSettlementRequestApiClient.mockReturnValue({ runPayoutReconciliation });

    const result = await action({
      request: formRequest(new URLSearchParams({ intent: "retry" })),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({ reconciliationStatus: "Payout retry queued." });
    expect(runPayoutReconciliation).toHaveBeenCalledWith({ limit: 100 });
  });

  it.each([
    [legacyPayoutsLoader, "http://localhost/account/payouts?filter=failed"],
    [legacySettlementLoader, "http://localhost/account/settlement?tab=pending"],
  ])("redirects a legacy overview to the single money dashboard", (legacyLoader, requestUrl) => {
    const response = legacyLoader({
      request: new Request(requestUrl),
      params: {},
      context: undefined,
    } as never) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toMatch(/^\/account\/desk\/money\?/);
  });

  it("redirects wallet-adjustment details into the money dashboard drawer", () => {
    const response = legacyWalletAdjustmentLoader({
      request: new Request("http://localhost/account/wallet/adjustments/WAD-TEST"),
      params: { reference: "WAD-TEST" },
      context: undefined,
    } as never) as Response;

    expect(response.headers.get("Location")).toBe("/account/desk/money?drawer=wallet-adjustment&entity=WAD-TEST");
  });
});
