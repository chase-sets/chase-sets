import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFreshWriteToken, readFreshWriteToken } from "@chase-sets/http/responses";

const { MockFulfillmentApiError, fulfillmentCommit, mockApi, mockCreateFulfillmentRequestApiClient, mockRequireActor } =
  vi.hoisted(() => {
    class MockFulfillmentApiError extends Error {
      public constructor(
        public readonly status: number,
        public readonly body: unknown,
        message = "Fulfillment API request failed.",
      ) {
        super(message);
      }
    }

    function fulfillmentCommit(position = "42", status = "packing") {
      return {
        id: "shp_1",
        version: Number(position),
        status,
        commandReceipt: {
          mode: "eventual",
          commitPosition: position,
          commitEventIds: [`evt_fulfillment_${position}`],
          commitPositions: [
            {
              sourceContextName: "fulfillment",
              maxGlobalPosition: position,
              eventIds: [`evt_fulfillment_${position}`],
            },
          ],
        },
      };
    }

    return {
      MockFulfillmentApiError,
      fulfillmentCommit,
      mockApi: {
        getSellerShipment: vi.fn(),
        startPackingShipment: vi.fn(),
        packShipment: vi.fn(),
        updatePackingLineQuantity: vi.fn(),
      },
      mockCreateFulfillmentRequestApiClient: vi.fn(),
      mockRequireActor: vi.fn(),
    };
  });

vi.mock("@chase-sets/platform-runtime/auth", () => ({
  requireActorFromAuthApi: mockRequireActor,
}));

vi.mock("../../support/request-support/api-client", () => ({
  FulfillmentApiError: MockFulfillmentApiError,
  createFulfillmentRequestApiClient: mockCreateFulfillmentRequestApiClient,
}));

import { action, loader } from "./account-sale-shipment-packing";

function formRequest(values: Record<string, string>) {
  return new Request("https://marketplace.chasesets.test/account/sales/shipments/shp_1/packing", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  });
}

function freshRequest(path: string, position = "42") {
  return new Request(`https://marketplace.chasesets.test${appendFreshWriteToken(path, fulfillmentCommit(position))}`);
}

function expiredFreshRequest(path: string, position = "42") {
  return new Request(
    `https://marketplace.chasesets.test${appendFreshWriteToken(path, fulfillmentCommit(position), 1_000)}`,
  );
}

describe("fulfillment seller shipment packing route", () => {
  beforeEach(() => {
    mockRequireActor.mockResolvedValue({ accountId: "acc_seller", permissions: ["fulfillment.manage"] });
    mockCreateFulfillmentRequestApiClient.mockReturnValue(mockApi);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects packing start with the Fulfillment command receipt instead of polling the projection", async () => {
    mockApi.startPackingShipment.mockResolvedValue(fulfillmentCommit("61"));

    const response = (await action({
      request: formRequest({ intent: "start-packing" }),
      params: { shipmentId: "shp_1" },
      context: undefined,
    } as never)) as Response;

    const location = response.headers.get("Location") ?? "";
    expect(response.status).toBe(302);
    expect(location).toContain("/account/sales/shipments/shp_1/packing?afterWrite=");
    expect(readFreshWriteToken(`https://marketplace.chasesets.test${location}`)?.commitPosition).toBe("61");
    expect(mockApi.getSellerShipment).not.toHaveBeenCalled();
  });

  it("redirects packing completion with the Fulfillment command receipt", async () => {
    mockApi.packShipment.mockResolvedValue(fulfillmentCommit("62", "packed"));

    const response = (await action({
      request: formRequest({ intent: "complete-packing", packageCount: "1" }),
      params: { shipmentId: "shp_1" },
      context: undefined,
    } as never)) as Response;

    const location = response.headers.get("Location") ?? "";
    expect(response.status).toBe(302);
    expect(location).toContain("/account/sales/shipments/shp_1?afterWrite=");
    expect(readFreshWriteToken(`https://marketplace.chasesets.test${location}`)?.commitPosition).toBe("62");
  });

  it("returns the packing line command snapshot for optimistic correction", async () => {
    mockApi.updatePackingLineQuantity.mockResolvedValue({
      id: "shp_1",
      lineId: "spl_1",
      version: 63,
      confirmedQuantity: 2,
      commandReceipt: fulfillmentCommit("63").commandReceipt,
    });

    const result = await action({
      request: formRequest({
        intent: "set-line-confirmed",
        lineId: "spl_1",
        confirmedQuantity: "2",
        mutationAttemptId: "018f47d2-9d2a-4d68-8f33-6fb718c3f001",
      }),
      params: { shipmentId: "shp_1" },
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      id: "shp_1",
      lineId: "spl_1",
      version: 63,
      confirmedQuantity: 2,
    });
    expect(mockApi.updatePackingLineQuantity).toHaveBeenCalledWith(
      "shp_1",
      "spl_1",
      2,
      "018f47d2-9d2a-4d68-8f33-6fb718c3f001",
    );
  });

  it("returns temporary recovery when a fresh packing read times out on projection freshness", async () => {
    mockApi.getSellerShipment.mockRejectedValue(
      new MockFulfillmentApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Fulfillment packing projection is catching up.",
        },
      }),
    );
    const request = freshRequest("/account/sales/shipments/shp_1/packing", "64");

    const result = await loader({
      request,
      params: { shipmentId: "shp_1" },
      context: undefined,
    } as never);

    expect(mockCreateFulfillmentRequestApiClient).toHaveBeenCalledWith(request);
    expect(result).toEqual({
      shipment: null,
      freshnessError: "Fulfillment packing projection is catching up.",
    });
  });

  it("returns temporary recovery when a fresh packing read is not found yet", async () => {
    mockApi.getSellerShipment.mockRejectedValue(
      new MockFulfillmentApiError(404, {
        error: {
          code: "not_found",
          message: "Packing has not projected yet.",
        },
      }),
    );
    const request = freshRequest("/account/sales/shipments/shp_1/packing", "65");

    const result = await loader({
      request,
      params: { shipmentId: "shp_1" },
      context: undefined,
    } as never);

    expect(result).toEqual({
      shipment: null,
      freshnessError: "Packing has not projected yet.",
    });
  });

  it("treats expired packing handoffs as permanent not found", async () => {
    mockApi.getSellerShipment.mockRejectedValue(
      new MockFulfillmentApiError(404, {
        error: {
          code: "not_found",
          message: "Shipment not found.",
        },
      }),
    );

    await expect(
      loader({
        request: expiredFreshRequest("/account/sales/shipments/shp_1/packing", "66"),
        params: { shipmentId: "shp_1" },
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });
});
