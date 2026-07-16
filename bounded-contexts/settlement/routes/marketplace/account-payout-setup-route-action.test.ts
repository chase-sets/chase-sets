import { afterEach, describe, expect, it, vi } from "vitest";
import { readCompactPostWriteToken, readFreshWriteToken } from "@chase-sets/http/responses";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";

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

import { action as accountPayoutSetupAction, loader as accountPayoutSetupLoader } from "./account-payout-setup";
import { loader as legacyAccountPayoutSetupLoader } from "./account-desk-settings";

async function readResolvedFreshWriteToken(url: URL) {
  const resolvedRequest = await resolvePlatformPostWriteRequest(new Request(url));
  return readFreshWriteToken(resolvedRequest.url);
}

function readyPayoutReadiness() {
  return {
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
  };
}

function formRequest(form: URLSearchParams, url = "http://localhost/account/desk/settings") {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

describe("settlement account payout setup route action", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("redirects the legacy payout setup URL to Seller Desk settings", async () => {
    let response: Response | null = null;
    try {
      response = legacyAccountPayoutSetupLoader({
        request: new Request("http://localhost/account/payouts/setup?mode=manage"),
        params: {},
        context: undefined,
      } as never) as Response;
    } catch (error) {
      response = error as Response;
    }

    expect(response?.status).toBe(302);
    expect(response?.headers.get("Location")).toBe("/account/desk/settings?mode=manage");
  });

  it("returns an account access state instead of throwing 403 for signed-in actors without payout setup access", async () => {
    mockResolveRequiredActorFromAuthApi.mockResolvedValue({
      kind: "forbidden",
      actor: { accountId: "acc_platform", permissions: ["accounts.view"] },
      requiredPermission: "payouts.setup",
    });
    const getPayoutReadiness = vi.fn();
    mockCreateSettlementRequestApiClient.mockReturnValue({ getPayoutReadiness });

    const result = await accountPayoutSetupLoader({
      request: new Request("http://localhost/account/desk/settings?mode=manage"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      accountAccessRequired: {
        returnTo: "/account/desk/settings?mode=manage",
      },
    });
    expect(getPayoutReadiness).not.toHaveBeenCalled();
  });

  it("returns refreshed payout readiness without waiting for the setup loader projection", async () => {
    const refreshPayoutSetup = vi.fn(async () => readyPayoutReadiness());
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

  it("redirects ready payout refreshes to safe account return targets with Settlement freshness", async () => {
    const refreshPayoutSetup = vi.fn(async () => ({
      ...readyPayoutReadiness(),
      commandReceipt: {
        mode: "eventual",
        commitEventIds: ["evt_payout_ready"],
        commitPositions: [
          {
            sourceContextName: "settlement",
            maxGlobalPosition: "42",
            eventIds: ["evt_payout_ready"],
          },
        ],
      },
    }));
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: ["payouts.setup"] });
    mockCreateSettlementRequestApiClient.mockReturnValue({ refreshPayoutSetup });

    const result = await accountPayoutSetupAction({
      request: formRequest(
        new URLSearchParams({
          intent: "refresh-payout-setup",
          mode: "setup",
        }),
        "http://localhost/account/desk/settings?returnTo=%2Faccount%2Fsell-list",
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    const location = (result as Response).headers.get("Location");
    const redirectUrl = new URL(location ?? "", "http://localhost");
    expect(redirectUrl.pathname).toBe("/account/sell-list");
    expect(readCompactPostWriteToken(redirectUrl)).toMatch(/^pwt_/);
    expect(redirectUrl.searchParams.has("afterWrite")).toBe(false);
    expect(redirectUrl.searchParams.has("postWriteHandoff")).toBe(false);
    expect((await readResolvedFreshWriteToken(redirectUrl))?.sources).toEqual([
      {
        sourceContextName: "settlement",
        maxGlobalPosition: "42",
        eventIds: ["evt_payout_ready"],
      },
    ]);
  });

  it("ignores unsafe return targets and keeps the command-owned readiness snapshot", async () => {
    const refreshPayoutSetup = vi.fn(async () => ({
      ...readyPayoutReadiness(),
      commandReceipt: {
        mode: "eventual",
        commitEventIds: ["evt_payout_ready"],
        commitPositions: [
          {
            sourceContextName: "settlement",
            maxGlobalPosition: "42",
            eventIds: ["evt_payout_ready"],
          },
        ],
      },
    }));
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: ["payouts.setup"] });
    mockCreateSettlementRequestApiClient.mockReturnValue({ refreshPayoutSetup });

    const result = await accountPayoutSetupAction({
      request: formRequest(
        new URLSearchParams({
          intent: "refresh-payout-setup",
          mode: "setup",
        }),
        "http://localhost/account/desk/settings?returnTo=https%3A%2F%2Fexample.test%2Fsteal",
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      payoutReadiness: {
        account_id: "acc_seller",
        status: "ready",
      },
      setupNotice: expect.any(String),
    });
  });

  it("keeps not-ready provider refresh snapshots on the setup page instead of redirecting to return targets", async () => {
    const refreshPayoutSetup = vi.fn(async () => ({
      ...readyPayoutReadiness(),
      status: "pending",
      missing_requirements: ["external_account"],
      onboarding_status: "pending",
      payout_destination_status: "missing",
      commandReceipt: {
        mode: "eventual",
        commitEventIds: ["evt_payout_pending"],
        commitPositions: [
          {
            sourceContextName: "settlement",
            maxGlobalPosition: "41",
            eventIds: ["evt_payout_pending"],
          },
        ],
      },
    }));
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: ["payouts.setup"] });
    mockCreateSettlementRequestApiClient.mockReturnValue({ refreshPayoutSetup });

    const result = await accountPayoutSetupAction({
      request: formRequest(
        new URLSearchParams({
          intent: "refresh-payout-setup",
          mode: "setup",
        }),
        "http://localhost/account/desk/settings?returnTo=%2Faccount%2Fsell-list",
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      payoutReadiness: {
        account_id: "acc_seller",
        status: "pending",
        missing_requirements: ["external_account"],
      },
      setupNotice: expect.any(String),
    });
    expect(result).not.toBeInstanceOf(Response);
  });

  it("keeps provider refresh failures as action errors instead of redirect freshness recovery", async () => {
    const { SettlementApiError } = await import("../../support/request-support/api-client");
    const refreshPayoutSetup = vi.fn(async () => {
      throw new SettlementApiError(400, {
        error: {
          code: "provider_readiness_failed",
          message: "Provider onboarding is still pending.",
        },
      });
    });
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: ["payouts.setup"] });
    mockCreateSettlementRequestApiClient.mockReturnValue({ refreshPayoutSetup });

    const result = await accountPayoutSetupAction({
      request: formRequest(
        new URLSearchParams({
          intent: "refresh-payout-setup",
          mode: "setup",
        }),
        "http://localhost/account/desk/settings?returnTo=%2Faccount%2Fsell-list",
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      error: expect.any(String),
    });
    expect(result).not.toBeInstanceOf(Response);
  });
});
