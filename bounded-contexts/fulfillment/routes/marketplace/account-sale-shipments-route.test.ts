import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockApi, mockCreateFulfillmentRequestApiClient, mockRequireActor } = vi.hoisted(() => ({
  mockApi: { cancelShipment: vi.fn(), getSellerCommandCenter: vi.fn() },
  mockCreateFulfillmentRequestApiClient: vi.fn(),
  mockRequireActor: vi.fn(),
}));

vi.mock("@chase-sets/platform-runtime/auth", () => ({ requireActorFromAuthApi: mockRequireActor }));
vi.mock("../../support/request-support/api-client", () => ({
  createFulfillmentRequestApiClient: mockCreateFulfillmentRequestApiClient,
}));

import { action, loader } from "./account-sale-shipments";

function formRequest(values: Record<string, string>) {
  return new Request("https://marketplace.chasesets.test/account/sales/shipments", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  });
}

describe("fulfillment seller command-center route", () => {
  beforeEach(() => {
    mockRequireActor.mockResolvedValue({ accountId: "acc_seller", permissions: ["fulfillment.manage"] });
    mockCreateFulfillmentRequestApiClient.mockReturnValue(mockApi);
  });

  afterEach(() => vi.clearAllMocks());

  it("draws the command center the Fulfillment API returns", async () => {
    const commandCenter = { source: "fulfillment-ship-by", buckets: [], queue: [], totalNeedingAttention: 0 };
    mockApi.getSellerCommandCenter.mockResolvedValue(commandCenter);
    mockRequireActor.mockResolvedValue({
      tenantId: "tnt_1",
      accountId: "acc_seller",
      permissions: ["fulfillment.view"],
    });
    const data = await loader({
      request: new Request("https://marketplace.chasesets.test/account/sales/shipments"),
      params: {},
      context: undefined,
    } as never);
    expect(data).toEqual({ commandCenter, recoveryScope: { tenantId: "tnt_1", sellerAccountId: "acc_seller" } });
    expect(mockApi.getSellerCommandCenter).toHaveBeenCalledTimes(1);
  });

  it("enrolls cancel-shipment and calls the real client seam exactly once", async () => {
    mockApi.cancelShipment.mockResolvedValue({ id: "shp_race", version: 4 });
    const response = (await action({
      request: formRequest({
        intent: "cancel-shipment",
        shipmentId: "shp_race",
        status: "packing",
        labelStatus: "not-purchased",
        hasOrderCancellationConflict: "true",
        mutationAttemptId: "attempt-race",
      }),
      params: {},
      context: undefined,
    } as never)) as Response;
    expect(response.status).toBe(302);
    expect(mockApi.cancelShipment).toHaveBeenCalledTimes(1);
    expect(mockApi.cancelShipment).toHaveBeenCalledWith("shp_race", "attempt-race");
  });

  it("cannot use a forged positive form fact to override aggregate refusal", async () => {
    mockApi.cancelShipment.mockRejectedValueOnce(
      new Error("Only shipments with an order cancellation conflict can be cancelled."),
    );
    const result = await action({
      request: formRequest({
        intent: "cancel-shipment",
        shipmentId: "shp_race",
        status: "packing",
        labelStatus: "not-purchased",
        hasOrderCancellationConflict: "true",
        mutationAttemptId: "attempt-forged",
      }),
      params: {},
      context: undefined,
    } as never);
    expect(result).toEqual({ error: "Only shipments with an order cancellation conflict can be cancelled." });
    expect(mockApi.cancelShipment).toHaveBeenCalledTimes(1);
  });
});
