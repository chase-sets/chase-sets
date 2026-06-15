import { afterEach, describe, expect, it, vi } from "vitest";

const { mockCreateSettlementRequestApiClient, mockRequireActorFromAuthApi } = vi.hoisted(() => ({
  mockCreateSettlementRequestApiClient: vi.fn(),
  mockRequireActorFromAuthApi: vi.fn(),
}));

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );

  return {
    ...actual,
    requireActorFromAuthApi: mockRequireActorFromAuthApi,
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

import { action as accountPayoutSetupAction } from "./account-payout-setup";

function formRequest(form: URLSearchParams) {
  return new Request("http://localhost/account/payouts/setup", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

describe("settlement account payout setup route action", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns refreshed payout readiness without waiting for the setup loader projection", async () => {
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
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: ["payouts.setup"] });
    mockCreateSettlementRequestApiClient.mockReturnValue({ refreshPayoutSetup });
    const form = new URLSearchParams({
      intent: "refresh-payout-setup",
      mode: "management",
    });

    const result = await accountPayoutSetupAction({
      request: formRequest(form),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      payoutReadiness: {
        account_id: "acc_seller",
        status: "ready",
        provider_reference: "acct_test",
      },
      setupNotice: expect.any(String),
    });
    expect(refreshPayoutSetup).toHaveBeenCalledTimes(1);
  });
});
