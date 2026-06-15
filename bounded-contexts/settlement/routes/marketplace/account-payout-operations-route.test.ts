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

import { action as accountPayoutOperationsAction } from "./account-payout-operations";

function formRequest(form: URLSearchParams) {
  return new Request("http://localhost/account/payout-operations", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

describe("settlement account payout operations route action", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns the queued reconciliation job snapshot for operator correction", async () => {
    const runPayoutReconciliation = vi.fn(async () => ({
      jobId: "job_reconcile",
      status: "queued",
      progress: {
        phase: "queued",
        completed: 0,
        total: 3,
        message: "Payout reconciliation queued.",
      },
      result: null,
    }));
    mockRequireActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: ["payouts.reconcile"] });
    mockCreateSettlementRequestApiClient.mockReturnValue({ runPayoutReconciliation });
    const form = new URLSearchParams({ intent: "run-reconciliation" });

    const result = await accountPayoutOperationsAction({
      request: formRequest(form),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      jobId: "job_reconcile",
      status: "queued",
      progress: {
        phase: "queued",
        total: 3,
      },
    });
    expect(runPayoutReconciliation).toHaveBeenCalledWith({ limit: 100 });
  });
});
