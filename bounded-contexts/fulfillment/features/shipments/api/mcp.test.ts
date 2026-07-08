import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createFulfillmentShipmentMcpHandlers } from "./mcp";
import type { FulfillmentShipmentServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_seller",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["fulfillment.view", "fulfillment.manage"],
} satisfies ResolvedActor;

const buyerActor = {
  ...actor,
  accountId: "acc_buyer",
  permissions: ["fulfillment.view"],
} satisfies ResolvedActor;

const legacyMcpProtocol = {
  protocolVersion: "2025-06-18",
  stateless: false,
  clientInfo: null,
  clientCapabilities: null,
} satisfies McpRequestProtocolContext;

function mcpRequest(arguments_: Record<string, unknown>, requestActor: ResolvedActor = actor) {
  return {
    actor: requestActor,
    tool: null as never,
    arguments: arguments_,
    request: new Request("https://api.test/mcp"),
    protocol: legacyMcpProtocol,
  };
}

function shipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    shipment_id: "shp_1",
    order_id: "ord_1",
    buyer_account_id: "acc_buyer",
    buyer_display_name: "Buyer",
    seller_account_id: "acc_seller",
    seller_display_name: "Seller",
    shipping_option: "standard",
    shipping_destination_snapshot: {
      name: "Buyer",
      line1: "2 Market",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    },
    shipping_origin_snapshot: {
      name: "Seller",
      line1: "1 Main",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    },
    shipping_plan_snapshot: null,
    shipping_method: "standard",
    carrier_name: "USPS",
    label_reference: "pl_1",
    label_document_url: "https://labels.test/pl_1.pdf",
    tracking_identifier: "940000000000000000",
    postage_provider_name: "easypost",
    postage_provider_mode: "test",
    postage_provider_shipment_id: "pshp_1",
    postage_provider_label_id: "pl_1",
    postage_rate_id: "rate_1",
    postage_service_level: "USPS_GROUND_ADVANTAGE",
    postage_amount_cents: 499,
    postage_currency: "USD",
    label_status: "purchased",
    label_error_code: null,
    label_error_message: null,
    label_refund_status: null,
    label_refund_reference: null,
    status: "label-attached",
    package_status: "packed",
    package_count: 1,
    current_exception_type: null,
    current_exception_notes: null,
    created_at: "2026-07-08T00:00:00.000Z",
    updated_at: "2026-07-08T00:05:00.000Z",
    packing_started_at: "2026-07-08T00:01:00.000Z",
    package_prepared_at: "2026-07-08T00:02:00.000Z",
    label_attached_at: "2026-07-08T00:03:00.000Z",
    label_voided_at: null,
    cancelled_at: null,
    dispatched_at: "2026-07-08T00:04:00.000Z",
    delivered_at: null,
    returned_at: null,
    exception_raised_at: null,
    line_count: 1,
    total_quantity: 1,
    lines: [],
    exceptions: [],
    address_override_audits: [],
    postage_label_operations: [],
    postage_provider_events: [
      {
        provider_event_id: "evt_1",
        provider_name: "easypost",
        provider_mode: "test",
        event_kind: "tracking-status",
        provider_object_reference: "trk_1",
        tracking_identifier: "940000000000000000",
        status: "in_transit",
        status_detail: null,
        processing_result: "dispatched",
        occurred_at: "2026-07-08T00:04:00.000Z",
        received_at: "2026-07-08T00:04:01.000Z",
      },
    ],
    ...overrides,
  };
}

function services(): FulfillmentShipmentServices {
  return {
    listBuyerShipments: vi.fn(async () => ({ items: [shipmentRow({ shipping_origin_snapshot: null })], total: 1 })),
    getBuyerShipment: vi.fn(async (shipmentId, buyerAccountId) =>
      buyerAccountId === "acc_buyer"
        ? shipmentRow({ shipment_id: shipmentId, buyer_account_id: buyerAccountId, shipping_origin_snapshot: null })
        : null,
    ),
    listSellerShipments: vi.fn(async () => ({ items: [shipmentRow()], total: 1 })),
    getSellerShipment: vi.fn(async (shipmentId, sellerAccountId) =>
      sellerAccountId === "acc_seller"
        ? shipmentRow({ shipment_id: shipmentId, seller_account_id: sellerAccountId })
        : null,
    ),
    purchaseUspsLabel: vi.fn(async (params) => ({
      shipmentId: params.shipmentId,
      version: 5,
      trackingIdentifier: "940000000000000001",
    })),
    voidLabel: vi.fn(async (params) => ({ shipmentId: params.shipmentId, version: 6 })),
  } as unknown as FulfillmentShipmentServices;
}

describe("fulfillment shipment MCP handlers", () => {
  it("lists seller shipments with natural account scope", async () => {
    const fakeServices = services();
    const handlers = createFulfillmentShipmentMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["fulfillment.list-shipments"]?.(
      mcpRequest({ accountId: "acc_seller", side: "sale", limit: 25, offset: 5 }),
    );

    expect(result).toMatchObject({ accountId: "acc_seller", side: "sale", total: 1, count: 1 });
    expect(fakeServices.listSellerShipments).toHaveBeenCalledWith({
      sellerAccountId: "acc_seller",
      limit: 25,
      offset: 5,
    });
  });

  it("purchases labels through Fulfillment and returns an MCP write receipt", async () => {
    const fakeServices = services();
    const handlers = createFulfillmentShipmentMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["fulfillment.purchase-label"]?.(
      mcpRequest({
        accountId: "acc_seller",
        shipmentId: "shp_1",
        serviceLevel: "USPS_GROUND_ADVANTAGE",
        sender: { name: "Seller", street1: "1 Main", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
        recipient: {
          name: "Buyer",
          line1: "2 Market",
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
        },
        package: { lengthInches: 7, widthInches: 5, heightInches: 1, weightOunces: 4 },
      }),
    );

    expect(result).toMatchObject({
      accountId: "acc_seller",
      id: "shp_1",
      shipmentId: "shp_1",
      version: 5,
      status: "label-attached",
      trackingIdentifier: "940000000000000001",
      resourceUri: "chase-sets://fulfillment/acc_seller/shipments/shp_1",
    });
    expect(fakeServices.purchaseUspsLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        shipmentId: "shp_1",
        sellerAccountId: "acc_seller",
        serviceLevel: "USPS_GROUND_ADVANTAGE",
        sender: expect.objectContaining({ street1: "1 Main" }),
        recipient: expect.objectContaining({ street1: "2 Market" }),
        package: { lengthInches: 7, widthInches: 5, heightInches: 1, weightOunces: 4 },
      }),
      expect.objectContaining({
        audit: { performedByUserId: "usr_1", forAccountId: "acc_seller" },
      }),
    );
  });

  it("voids labels through Fulfillment and rejects dry-run writes", async () => {
    const fakeServices = services();
    const handlers = createFulfillmentShipmentMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["fulfillment.void-label"]?.(mcpRequest({ accountId: "acc_seller", shipmentId: "shp_1" })),
    ).resolves.toMatchObject({ shipmentId: "shp_1", version: 6, status: "label-voided" });
    await expect(
      handlers.toolHandlers["fulfillment.purchase-label"]?.(
        mcpRequest({ accountId: "acc_seller", shipmentId: "shp_1", dryRun: true }),
      ),
    ).rejects.toThrow("dryRun is not supported for fulfillment shipment MCP writes yet.");
  });

  it("rejects account mismatches and reads shipment resources by URI", async () => {
    const fakeServices = services();
    const handlers = createFulfillmentShipmentMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["fulfillment.list-shipments"]?.(mcpRequest({ accountId: "acc_other" })),
    ).rejects.toThrow("accountId must match the authenticated actor account.");

    const result = await handlers.resourceHandlers["chase-sets://fulfillment/{accountId}/shipments/{shipmentId}"]?.({
      actor,
      resource: null as never,
      uri: "chase-sets://fulfillment/acc_seller/shipments/shp_1",
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({
      shipment_id: "shp_1",
      seller_account_id: "acc_seller",
      tracking_identifier: "940000000000000000",
      postage_provider_events: [expect.objectContaining({ provider_event_id: "evt_1", status: "in_transit" })],
    });
  });

  it("reads buyer shipment resources without exposing origin data reserved for sale shipments", async () => {
    const fakeServices = services();
    const handlers = createFulfillmentShipmentMcpHandlers(fakeServices);

    const result = await handlers.resourceHandlers["chase-sets://fulfillment/{accountId}/shipments/{shipmentId}"]?.({
      actor: buyerActor,
      resource: null as never,
      uri: "chase-sets://fulfillment/acc_buyer/shipments/shp_1",
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({
      shipment_id: "shp_1",
      buyer_account_id: "acc_buyer",
      shipping_origin_snapshot: null,
    });
    expect(fakeServices.getBuyerShipment).toHaveBeenCalledWith("shp_1", "acc_buyer");
  });
});
