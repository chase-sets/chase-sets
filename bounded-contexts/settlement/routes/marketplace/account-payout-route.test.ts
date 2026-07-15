import { afterEach, describe, expect, it, vi } from "vitest";
import { navigateAfterWrite } from "@chase-sets/platform-runtime/http";

const { mockCreateSettlementRequestApiClient, mockGetPayout, mockRequireActorFromAuthApi } = vi.hoisted(() => ({
  mockCreateSettlementRequestApiClient: vi.fn(),
  mockGetPayout: vi.fn(),
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

vi.mock("../../support/request-support/api-client", () => ({
  createSettlementRequestApiClient: mockCreateSettlementRequestApiClient,
  SettlementApiError: class SettlementApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super("Settlement API error");
    }
  },
}));

import { loader as accountPayoutLoader } from "./account-desk-payout";
import { loader as legacyAccountPayoutLoader } from "./account-payout";

function settlementCommit(position = "42", eventId = "evt_settlement_payout") {
  return {
    mode: "eventual",
    commitPosition: position,
    commitEventIds: [eventId],
    commitPositions: [
      {
        sourceContextName: "settlement",
        maxGlobalPosition: position,
        eventIds: [eventId],
      },
    ],
  };
}

function freshPayoutRequest() {
  return new Request(
    `http://localhost${navigateAfterWrite(settlementCommit(), "/account/desk/payouts/pyo_test?requested=1")}`,
  );
}

function expiredPayoutRequest() {
  return new Request(
    `http://localhost${navigateAfterWrite(settlementCommit(), "/account/desk/payouts/pyo_test?requested=1", {
      nowMs: Date.now() - 31_000,
    })}`,
  );
}

describe("settlement account payout route loader", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns temporary recovery when a fresh payout detail read hits projection freshness timeout", async () => {
    const { SettlementApiError } = await import("../../support/request-support/api-client");
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["payouts.view"],
    });
    mockGetPayout.mockRejectedValue(
      new SettlementApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Projection read model did not catch up before the freshness timeout.",
        },
      }),
    );
    mockCreateSettlementRequestApiClient.mockReturnValue({ getPayout: mockGetPayout });

    const result = await accountPayoutLoader({
      request: freshPayoutRequest(),
      params: { payoutId: "pyo_test" },
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      payout: null,
      recovery: "fresh-write-preparing",
      requestSuccess: true,
    });
  });

  it("returns temporary recovery when a fresh payout detail read is not found during projection catch-up", async () => {
    const { SettlementApiError } = await import("../../support/request-support/api-client");
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["payouts.view"],
    });
    mockGetPayout.mockRejectedValue(
      new SettlementApiError(404, {
        error: { code: "not_found", message: "Payout not found." },
      }),
    );
    mockCreateSettlementRequestApiClient.mockReturnValue({ getPayout: mockGetPayout });

    const result = await accountPayoutLoader({
      request: freshPayoutRequest(),
      params: { payoutId: "pyo_test" },
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      payout: null,
      recovery: "fresh-write-preparing",
    });
    expect(mockGetPayout).toHaveBeenCalledTimes(6);
  });

  it("keeps manual missing payout links on the permanent not-found path", async () => {
    const { SettlementApiError } = await import("../../support/request-support/api-client");
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["payouts.view"],
    });
    mockGetPayout.mockRejectedValue(
      new SettlementApiError(404, {
        error: { code: "not_found", message: "Payout not found." },
      }),
    );
    mockCreateSettlementRequestApiClient.mockReturnValue({ getPayout: mockGetPayout });

    let response: Response | null = null;
    try {
      await accountPayoutLoader({
        request: new Request("http://localhost/account/desk/payouts/pyo_test"),
        params: { payoutId: "pyo_test" },
        context: undefined,
      } as never);
    } catch (error) {
      response = error as Response;
    }

    expect(response?.status).toBe(404);
    await expect(response?.text()).resolves.toBe("Payout not found.");
  });

  it("keeps expired payout receipts on the permanent not-found path", async () => {
    const { SettlementApiError } = await import("../../support/request-support/api-client");
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["payouts.view"],
    });
    mockGetPayout.mockRejectedValue(
      new SettlementApiError(404, {
        error: { code: "not_found", message: "Payout not found." },
      }),
    );
    mockCreateSettlementRequestApiClient.mockReturnValue({ getPayout: mockGetPayout });

    let response: Response | null = null;
    try {
      await accountPayoutLoader({
        request: expiredPayoutRequest(),
        params: { payoutId: "pyo_test" },
        context: undefined,
      } as never);
    } catch (error) {
      response = error as Response;
    }

    expect(response?.status).toBe(404);
    await expect(response?.text()).resolves.toBe("Payout not found.");
    expect(mockGetPayout).toHaveBeenCalledTimes(1);
  });

  it("redirects the legacy payout detail route to its Seller Desk entity surface", () => {
    const response = legacyAccountPayoutLoader({
      request: new Request("http://localhost/account/payouts/pyo_test?requested=1"),
      params: { payoutId: "pyo_test" },
      context: undefined,
    } as never) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/desk/payouts/pyo_test?requested=1");
  });
});
