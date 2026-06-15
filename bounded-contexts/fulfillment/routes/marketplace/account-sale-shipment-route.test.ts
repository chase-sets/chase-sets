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

    function fulfillmentCommit(position = "42") {
      return {
        id: "shp_1",
        version: 3,
        status: "dispatched",
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
        packShipment: vi.fn(),
        purchaseUspsLabel: vi.fn(),
        voidLabel: vi.fn(),
        dispatchShipment: vi.fn(),
        deliverShipment: vi.fn(),
        returnShipment: vi.fn(),
        raiseShipmentException: vi.fn(),
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

import { action, loader } from "./account-sale-shipment";

function formRequest(values: Record<string, string>) {
  return new Request("https://marketplace.chasesets.test/account/sales/shipments/shp_1", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  });
}

function freshRequest(path: string, position = "42") {
  return new Request(`https://marketplace.chasesets.test${appendFreshWriteToken(path, fulfillmentCommit(position))}`);
}

describe("fulfillment seller shipment route", () => {
  beforeEach(() => {
    mockRequireActor.mockResolvedValue({ accountId: "acc_seller", permissions: ["fulfillment.manage"] });
    mockCreateFulfillmentRequestApiClient.mockReturnValue(mockApi);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects shipment lifecycle commands with the Fulfillment command receipt", async () => {
    mockApi.dispatchShipment.mockResolvedValue(fulfillmentCommit("51"));

    const response = (await action({
      request: formRequest({ intent: "dispatch-shipment" }),
      params: { shipmentId: "shp_1" },
      context: undefined,
    } as never)) as Response;

    const location = response.headers.get("Location") ?? "";
    expect(response.status).toBe(302);
    expect(location).toContain("/account/sales/shipments/shp_1?afterWrite=");
    expect(readFreshWriteToken(`https://marketplace.chasesets.test${location}`)).toMatchObject({
      commitPosition: "51",
      sources: [
        {
          sourceContextName: "fulfillment",
          maxGlobalPosition: "51",
          eventIds: ["evt_fulfillment_51"],
        },
      ],
    });
  });

  it("returns temporary recovery when a fresh shipment detail read times out on projection freshness", async () => {
    mockApi.getSellerShipment.mockRejectedValue(
      new MockFulfillmentApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Fulfillment shipment projection is catching up.",
        },
      }),
    );
    const request = freshRequest("/account/sales/shipments/shp_1", "52");

    const result = await loader({
      request,
      params: { shipmentId: "shp_1" },
      context: undefined,
    } as never);

    expect(mockCreateFulfillmentRequestApiClient).toHaveBeenCalledWith(request);
    expect(result).toEqual({
      shipment: null,
      freshnessError: "Fulfillment shipment projection is catching up.",
    });
  });

  it("treats projection freshness timeouts without a fresh receipt as permanent loader failures", async () => {
    mockApi.getSellerShipment.mockRejectedValue(
      new MockFulfillmentApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Fulfillment shipment projection is catching up.",
        },
      }),
    );

    await expect(
      loader({
        request: new Request("https://marketplace.chasesets.test/account/sales/shipments/shp_1"),
        params: { shipmentId: "shp_1" },
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 503 });
  });
});
