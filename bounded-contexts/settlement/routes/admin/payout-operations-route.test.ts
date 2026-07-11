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

import { action as payoutOperationsAction } from "./payout-operations";
import contextManifest from "../../context.json";

function formRequest(form: URLSearchParams) {
  return new Request("https://admin.chasesets.com/commerce/payout-operations", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

describe("settlement admin payout operations route action", () => {
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
    mockCreateSettlementRequestApiClient.mockReturnValue({ runPayoutReconciliation });
    const form = new URLSearchParams({ intent: "run-reconciliation" });

    const result = await payoutOperationsAction({
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

  it("ignores unsupported intents", async () => {
    const runPayoutReconciliation = vi.fn();
    mockCreateSettlementRequestApiClient.mockReturnValue({ runPayoutReconciliation });
    const form = new URLSearchParams({ intent: "noop" });

    const result = await payoutOperationsAction({
      request: formRequest(form),
      params: {},
      context: undefined,
    } as never);

    expect(result).toBeNull();
    expect(runPayoutReconciliation).not.toHaveBeenCalled();
  });

  it("contributes the payout operations route to admin-web commerce", () => {
    const adminContributions = contextManifest.deployableContributions.find(
      (contribution) => contribution.deployable === "admin-web",
    );

    expect(adminContributions?.routes).toContainEqual({
      routeId: "settlement-payout-operations",
      routePath: "payout-operations",
      fileExport: "./routes/admin/payout-operations",
      routeType: "route",
      sourceContext: "settlement",
      section: "commerce",
    });
  });

  it("no longer contributes payout operations to marketplace-web", () => {
    const marketplaceContributions = contextManifest.deployableContributions.find(
      (contribution) => contribution.deployable === "marketplace-web",
    );

    expect(marketplaceContributions?.routes.some((route) => route.routeId === "account-payout-operations")).toBe(false);
  });
});
