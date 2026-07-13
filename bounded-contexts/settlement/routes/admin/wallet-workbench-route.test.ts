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

import { SettlementApiError } from "../../support/request-support/api-client";
import { action as walletWorkbenchAction, loader as walletWorkbenchLoader } from "./wallet-workbench";
import contextManifest from "../../context.json";

function walletSummary() {
  return {
    account_id: "acc_test",
    currency_code: "usd",
    pending_balance_amount: "0.00",
    available_balance_amount: "0.00",
    total_credited_amount: "0.00",
    total_debited_amount: "0.00",
    negative_balance_status: "in-good-standing" as const,
    negative_balance_started_at: null,
    collections_escalated_at: null,
    opened_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function formRequest(accountId: string, form: URLSearchParams) {
  return new Request(`https://admin.chasesets.com/commerce/wallet-workbench/${accountId}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

describe("settlement admin wallet workbench route loader", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("loads the account wallet summary, adjustment history, and ledger", async () => {
    const getWalletAdjustmentAccountSummary = vi.fn(async () => walletSummary());
    const listWalletAdjustmentAccountHistory = vi.fn(async () => ({ items: [], total: 0, count: 0 }));
    const listWalletAdjustmentAccountLedger = vi.fn(async () => ({ items: [], total: 0, count: 0 }));
    mockCreateSettlementRequestApiClient.mockReturnValue({
      getWalletAdjustmentAccountSummary,
      listWalletAdjustmentAccountHistory,
      listWalletAdjustmentAccountLedger,
    });

    const result = await walletWorkbenchLoader({
      request: new Request("https://admin.chasesets.com/commerce/wallet-workbench/acc_test"),
      params: { accountId: "acc_test" },
      context: undefined,
    } as never);

    expect(getWalletAdjustmentAccountSummary).toHaveBeenCalledWith("acc_test");
    expect(listWalletAdjustmentAccountHistory).toHaveBeenCalled();
    expect(listWalletAdjustmentAccountLedger).toHaveBeenCalled();
    expect(result).toMatchObject({ status: "ok", accountId: "acc_test" });
  });

  it("returns a not-found status when the account has never opened a wallet", async () => {
    mockCreateSettlementRequestApiClient.mockReturnValue({
      getWalletAdjustmentAccountSummary: vi.fn(async () => {
        throw new SettlementApiError(404, { error: "account.not-found" });
      }),
    });

    const result = await walletWorkbenchLoader({
      request: new Request("https://admin.chasesets.com/commerce/wallet-workbench/acc_missing"),
      params: { accountId: "acc_missing" },
      context: undefined,
    } as never);

    expect(result).toMatchObject({ status: "not-found", accountId: "acc_missing" });
  });

  it("returns a permission-denied status on a 403 from the account summary", async () => {
    mockCreateSettlementRequestApiClient.mockReturnValue({
      getWalletAdjustmentAccountSummary: vi.fn(async () => {
        throw new SettlementApiError(403, { error: "forbidden" });
      }),
    });

    const result = await walletWorkbenchLoader({
      request: new Request("https://admin.chasesets.com/commerce/wallet-workbench/acc_test"),
      params: { accountId: "acc_test" },
      context: undefined,
    } as never);

    expect(result).toMatchObject({ status: "permission-denied" });
  });

  it("returns an unavailable status on an unexpected upstream failure", async () => {
    mockCreateSettlementRequestApiClient.mockReturnValue({
      getWalletAdjustmentAccountSummary: vi.fn(async () => {
        throw new SettlementApiError(503, { error: "unavailable" });
      }),
    });

    const result = await walletWorkbenchLoader({
      request: new Request("https://admin.chasesets.com/commerce/wallet-workbench/acc_test"),
      params: { accountId: "acc_test" },
      context: undefined,
    } as never);

    expect(result).toMatchObject({ status: "unavailable" });
  });

  it("returns an unavailable status when the history/ledger reads fail after a successful summary", async () => {
    mockCreateSettlementRequestApiClient.mockReturnValue({
      getWalletAdjustmentAccountSummary: vi.fn(async () => walletSummary()),
      listWalletAdjustmentAccountHistory: vi.fn(async () => {
        throw new SettlementApiError(500, { error: "boom" });
      }),
      listWalletAdjustmentAccountLedger: vi.fn(async () => ({ items: [], total: 0, count: 0 })),
    });

    const result = await walletWorkbenchLoader({
      request: new Request("https://admin.chasesets.com/commerce/wallet-workbench/acc_test"),
      params: { accountId: "acc_test" },
      context: undefined,
    } as never);

    expect(result).toMatchObject({ status: "unavailable" });
  });
});

describe("settlement admin wallet workbench route action", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("previews a proposed adjustment and returns the authoritative balance-impact snapshot", async () => {
    const previewWalletAdjustment = vi.fn(async () => ({
      target_account_id: "acc_test",
      direction: "credit",
      amount: "25.00",
      currency_code: "usd",
      reason_code: "goodwill-cash-credit",
      balance_revision: "wbr_1",
      available_balance_before: "100.00",
      available_balance_after: "125.00",
      pending_balance_amount: "0.00",
      cash_equivalent: true,
      spendable: true,
      payoutable: true,
      negative_balance_status: "in-good-standing",
      creates_or_increases_negative_balance: false,
      high_value: false,
      self_benefiting: false,
      blocked_reason: null,
      requires_second_approval: false,
      elevation_reasons: [],
      controls: {
        high_value_credit_threshold_amount: "500.00",
        high_value_debit_threshold_amount: "500.00",
        recent_auth_max_age_minutes: 15,
      },
    }));
    mockCreateSettlementRequestApiClient.mockReturnValue({ previewWalletAdjustment });

    const form = new URLSearchParams({
      intent: "preview-adjustment",
      direction: "credit",
      amount: "25.00",
      reasonCode: "goodwill-cash-credit",
    });
    const result = await walletWorkbenchAction({
      request: formRequest("acc_test", form),
      params: { accountId: "acc_test" },
      context: undefined,
    } as never);

    expect(previewWalletAdjustment).toHaveBeenCalledWith(
      expect.objectContaining({ targetAccountId: "acc_test", direction: "credit", amount: "25.00" }),
    );
    expect(result).toMatchObject({
      intent: "preview-adjustment",
      preview: { available_balance_after: "125.00" },
      values: { direction: "credit", amount: "25.00", reasonCode: "goodwill-cash-credit" },
    });
  });

  it("requests a wallet adjustment and returns the command-owned snapshot", async () => {
    const requestWalletAdjustment = vi.fn(async () => ({ adjustment_id: "wad_new", status: "requested" }));
    mockCreateSettlementRequestApiClient.mockReturnValue({ requestWalletAdjustment });

    const form = new URLSearchParams({
      intent: "request-adjustment",
      direction: "credit",
      amount: "12.50",
      reasonCode: "support-resolution",
      explanation: "Goodwill for shipping delay",
      evidenceReferences: "TCK-1",
      expectedBalanceRevision: "wbr_1",
    });
    form.append("evidenceReferences", "TCK-2");

    const result = await walletWorkbenchAction({
      request: formRequest("acc_test", form),
      params: { accountId: "acc_test" },
      context: undefined,
    } as never);

    expect(requestWalletAdjustment).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAccountId: "acc_test",
        direction: "credit",
        amount: "12.50",
        reasonCode: "support-resolution",
        evidenceReferences: ["TCK-1", "TCK-2"],
        expectedBalanceRevision: "wbr_1",
      }),
    );
    expect(result).toMatchObject({ intent: "request-adjustment", snapshot: { adjustment_id: "wad_new" } });
  });

  it("classifies a stale-balance conflict on request and preserves submitted values", async () => {
    const requestWalletAdjustment = vi.fn(async () => {
      throw new SettlementApiError(409, {
        error: {
          code: "conflict",
          message: "Wallet balance changed since preview; re-preview before confirming this adjustment.",
          details: [{ code: "stale_balance_revision", message: "stale" }],
        },
      });
    });
    mockCreateSettlementRequestApiClient.mockReturnValue({ requestWalletAdjustment });

    const form = new URLSearchParams({
      intent: "request-adjustment",
      direction: "credit",
      amount: "25.00",
      reasonCode: "goodwill-cash-credit",
      expectedBalanceRevision: "wbr_stale",
    });
    const result = await walletWorkbenchAction({
      request: formRequest("acc_test", form),
      params: { accountId: "acc_test" },
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      intent: "request-adjustment",
      error: { kind: "stale-preview" },
      values: { direction: "credit", amount: "25.00" },
    });
  });

  it("approves an adjustment", async () => {
    const approveWalletAdjustment = vi.fn(async () => ({ adjustment_id: "wad_1", status: "posted" }));
    mockCreateSettlementRequestApiClient.mockReturnValue({ approveWalletAdjustment });

    const form = new URLSearchParams({ intent: "approve-adjustment", adjustmentId: "wad_1" });
    const result = await walletWorkbenchAction({
      request: formRequest("acc_test", form),
      params: { accountId: "acc_test" },
      context: undefined,
    } as never);

    expect(approveWalletAdjustment).toHaveBeenCalledWith("wad_1", {});
    expect(result).toMatchObject({
      intent: "approve-adjustment",
      adjustmentId: "wad_1",
      snapshot: { status: "posted" },
    });
  });

  it("classifies the elevated-approval domain conflict without losing the adjustment id", async () => {
    const approveWalletAdjustment = vi.fn(async () => {
      throw new SettlementApiError(409, {
        error: { code: "conflict", message: "This Wallet Adjustment requires a second, elevated approval." },
      });
    });
    mockCreateSettlementRequestApiClient.mockReturnValue({ approveWalletAdjustment });

    const form = new URLSearchParams({ intent: "approve-adjustment", adjustmentId: "wad_1" });
    const result = await walletWorkbenchAction({
      request: formRequest("acc_test", form),
      params: { accountId: "acc_test" },
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      intent: "approve-adjustment",
      adjustmentId: "wad_1",
      error: { kind: "requires-elevated-approval" },
    });
  });

  it("retries approval with the supplied elevated approver", async () => {
    const approveWalletAdjustment = vi.fn(async () => ({ adjustment_id: "wad_1", status: "posted" }));
    mockCreateSettlementRequestApiClient.mockReturnValue({ approveWalletAdjustment });

    const form = new URLSearchParams({
      intent: "approve-adjustment",
      adjustmentId: "wad_1",
      elevationApprovedByUserId: "usr_elevated",
    });
    const result = await walletWorkbenchAction({
      request: formRequest("acc_test", form),
      params: { accountId: "acc_test" },
      context: undefined,
    } as never);

    expect(approveWalletAdjustment).toHaveBeenCalledWith("wad_1", { elevationApprovedByUserId: "usr_elevated" });
    expect(result).toMatchObject({ intent: "approve-adjustment" });
  });

  it("rejects an adjustment with a reason", async () => {
    const rejectWalletAdjustment = vi.fn(async () => ({ adjustment_id: "wad_1", status: "rejected" }));
    mockCreateSettlementRequestApiClient.mockReturnValue({ rejectWalletAdjustment });

    const form = new URLSearchParams({
      intent: "reject-adjustment",
      adjustmentId: "wad_1",
      rejectionReason: "Duplicate request",
    });
    const result = await walletWorkbenchAction({
      request: formRequest("acc_test", form),
      params: { accountId: "acc_test" },
      context: undefined,
    } as never);

    expect(rejectWalletAdjustment).toHaveBeenCalledWith("wad_1", { rejectionReason: "Duplicate request" });
    expect(result).toMatchObject({
      intent: "reject-adjustment",
      adjustmentId: "wad_1",
      snapshot: { status: "rejected" },
    });
  });

  it("reverses a posted adjustment", async () => {
    const reverseWalletAdjustment = vi.fn(async () => ({
      original: { adjustment_id: "wad_1", status: "reversed" },
      reversal: { adjustment_id: "wad_2", status: "posted" },
    }));
    mockCreateSettlementRequestApiClient.mockReturnValue({ reverseWalletAdjustment });

    const form = new URLSearchParams({
      intent: "reverse-adjustment",
      adjustmentId: "wad_1",
      approvedByUserId: "usr_approver",
      elevationApprovedByUserId: "usr_elevated",
    });
    const result = await walletWorkbenchAction({
      request: formRequest("acc_test", form),
      params: { accountId: "acc_test" },
      context: undefined,
    } as never);

    expect(reverseWalletAdjustment).toHaveBeenCalledWith(
      "wad_1",
      expect.objectContaining({ approvedByUserId: "usr_approver", elevationApprovedByUserId: "usr_elevated" }),
    );
    expect(result).toMatchObject({
      intent: "reverse-adjustment",
      adjustmentId: "wad_1",
      snapshot: { status: "reversed" },
      reversal: { status: "posted" },
    });
  });

  it("classifies an insufficient-permission response as forbidden instead of throwing", async () => {
    mockCreateSettlementRequestApiClient.mockReturnValue({
      approveWalletAdjustment: vi.fn(async () => {
        throw new SettlementApiError(403, { error: { code: "authorization_forbidden", message: "Forbidden." } });
      }),
    });

    const form = new URLSearchParams({ intent: "approve-adjustment", adjustmentId: "wad_1" });
    const result = await walletWorkbenchAction({
      request: formRequest("acc_test", form),
      params: { accountId: "acc_test" },
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      intent: "approve-adjustment",
      adjustmentId: "wad_1",
      error: { kind: "forbidden" },
    });
  });

  it("ignores unsupported intents", async () => {
    mockCreateSettlementRequestApiClient.mockReturnValue({});

    const form = new URLSearchParams({ intent: "noop" });
    const result = await walletWorkbenchAction({
      request: formRequest("acc_test", form),
      params: { accountId: "acc_test" },
      context: undefined,
    } as never);

    expect(result).toBeNull();
  });
});

describe("settlement admin wallet workbench route composition", () => {
  it("contributes the wallet workbench route to admin-web commerce", () => {
    const adminContributions = contextManifest.deployableContributions.find(
      (contribution) => contribution.deployable === "admin-web",
    );

    expect(adminContributions?.routes).toContainEqual({
      routeId: "settlement-wallet-workbench",
      routePath: "wallet-workbench/:accountId",
      fileExport: "./routes/admin/wallet-workbench",
      routeType: "route",
      sourceContext: "settlement",
      section: "commerce",
    });
  });

  it("does not contribute a standalone primary-nav entry, since the workbench is only reachable per-account", () => {
    const adminShellContributions = contextManifest.shellContributions.filter(
      (contribution) => contribution.deployable === "admin-web",
    );

    expect(adminShellContributions.some((contribution) => contribution.key === "settlement-wallet-workbench")).toBe(
      false,
    );
  });
});
