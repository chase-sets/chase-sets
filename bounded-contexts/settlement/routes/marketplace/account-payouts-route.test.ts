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

  it("loads wallet, ledger, and the Settlement payout summary from the owning context", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue(
      actor(["payouts.view", "payouts.request", "payouts.setup", "payouts.reconcile"]),
    );
    const api = {
      getWallet: vi.fn(async () => ({ account_id: "acc_seller" })),
      listWalletEntries: vi.fn(async () => ({ items: [], total: 0 })),
      listPayouts: vi.fn(async () => ({
        items: [],
        total: 0,
        count: 0,
        completeness: { kind: "complete", total: 0 },
        next_payout: null,
        blocked_payouts: [],
        availability: { can_request: true, unavailable_reasons: [], unavailable_reason_details: [] },
      })),
      getPayoutQuickAmounts: vi.fn(async () => ({
        currency_code: "usd",
        minimum_amount: "1.00",
        maximum_amount: "10000.00",
        full_available_amount: "125.00",
      })),
    };
    mockCreateSettlementRequestApiClient.mockReturnValue(api);

    const result = await loader({
      request: new Request("http://localhost/account/desk/money"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      canSetupPayouts: true,
      canReconcilePayouts: true,
      wallet: { account_id: "acc_seller" },
      entries: { items: [] },
      payoutSummary: { items: [], completeness: { kind: "complete" } },
      quickAmounts: { full_available_amount: "125.00" },
    });
    expect(api.getWallet).toHaveBeenCalledOnce();
    expect(api.listWalletEntries).toHaveBeenCalledOnce();
    expect(api.listPayouts).toHaveBeenCalledOnce();
    expect(api.getPayoutQuickAmounts).toHaveBeenCalledOnce();
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
      requested_amount: "12.50",
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

  it("payout preview sends quick amount selections to the Settlement API", async () => {
    const previewPayout = vi.fn(async ({ amount, amountSelection }: { amount?: string; amountSelection?: string }) => ({
      can_request: true,
      requested_amount: amountSelection === "minimum" ? "1.00" : amountSelection === "available" ? "125.00" : amount,
      estimated_wallet_balance_after: "0.00",
      unavailable_reason_details: [],
    }));
    mockRequireActorFromAuthApi.mockResolvedValue(actor(["payouts.view", "payouts.request"]));
    mockCreateSettlementRequestApiClient.mockReturnValue({ previewPayout });

    for (const [quickAmount, expectedAmount] of [
      ["minimum", "1.00"],
      ["available", "125.00"],
    ] as const) {
      const result = await action({
        request: formRequest(
          new URLSearchParams({
            intent: "preview-payout",
            quickAmount,
            availableAmount: "999999.00",
          }),
        ),
        params: {},
        context: undefined,
      } as never);

      expect(previewPayout).toHaveBeenLastCalledWith({ amountSelection: quickAmount });
      expect(result).toMatchObject({ confirmation: { amount: expectedAmount } });
    }

    const manualResult = await action({
      request: formRequest(new URLSearchParams({ intent: "preview-payout", amount: "12.50" })),
      params: {},
      context: undefined,
    } as never);
    expect(previewPayout).toHaveBeenLastCalledWith({ amount: "12.50" });
    expect(manualResult).toMatchObject({ confirmation: { amount: "12.50" } });
  });

  it("confirms the server-resolved preview amount without forwarding browser balance", async () => {
    const previewPayout = vi.fn(async () => ({
      can_request: true,
      requested_amount: "125.00",
      estimated_wallet_balance_after: "0.00",
      unavailable_reason_details: [],
    }));
    const createPayout = vi.fn(async () => ({
      id: "pyo_selected",
      version: 1,
      status: "in-transit",
      commitPosition: "43",
      commitPositions: [],
    }));
    mockRequireActorFromAuthApi.mockResolvedValue(actor(["payouts.view", "payouts.request"]));
    mockCreateSettlementRequestApiClient.mockReturnValue({ previewPayout, createPayout });

    const previewResult = (await action({
      request: formRequest(new URLSearchParams({ intent: "preview-payout", quickAmount: "available" })),
      params: {},
      context: undefined,
    } as never)) as { confirmation: { amount: string } };

    await action({
      request: formRequest(
        new URLSearchParams({
          intent: "confirm-payout",
          amount: previewResult.confirmation.amount,
          availableAmount: "999999.00",
        }),
      ),
      params: {},
      context: undefined,
    } as never);

    expect(createPayout).toHaveBeenCalledWith({
      amount: "125.00",
      destinationReference: null,
      note: null,
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
