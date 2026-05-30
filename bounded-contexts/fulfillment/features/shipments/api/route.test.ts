import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { FulfillmentApiEnv } from "../../../api";
import { createAccountShipmentRoutes, createAccountSaleShipmentRoutes } from "./route";
import type { FulfillmentShipmentServices } from "./runtime";

function buildSellerApp(
  options: Readonly<{
    actor: FulfillmentApiEnv["Variables"]["actor"];
    services: FulfillmentShipmentServices;
  }>,
) {
  const app = new Hono<FulfillmentApiEnv>();

  app.use("*", async (c, next) => {
    c.set("actor", options.actor);
    c.set(
      "context",
      options.actor
        ? {
            tenantId: "tnt_identity" as never,
            audit: {
              performedByUserId: options.actor.userId as never,
              forAccountId: options.actor.accountId as never,
            },
          }
        : null,
    );
    await next();
  });

  app.route("/account", createAccountShipmentRoutes(options.services));
  app.route("/account", createAccountSaleShipmentRoutes(options.services));

  return app;
}

function createServices(): FulfillmentShipmentServices {
  return {
    commandHandler: vi.fn(async () => ({
      state: {} as never,
      version: 1,
      newEvents: [],
      storedEvents: [],
    })),
    createShipmentForReadyOrder: vi.fn(async () => ({ shipmentId: "shp_1" as never })),
    cancelShipmentForCancelledOrder: vi.fn(async () => ({ shipmentId: "shp_1" as never, version: 2 })),
    startPackingShipment: vi.fn(async () => ({ shipmentId: "shp_1", version: 2 })),
    confirmPackingLine: vi.fn(async () => ({ shipmentId: "shp_1", version: 3 })),
    unconfirmPackingLine: vi.fn(async () => ({ shipmentId: "shp_1", version: 4 })),
    packShipment: vi.fn(async () => ({ shipmentId: "shp_1", version: 2 })),
    attachLabel: vi.fn(async () => ({ shipmentId: "shp_1", version: 3 })),
    purchaseUspsLabel: vi.fn(async () => ({
      shipmentId: "shp_1",
      version: 3,
      trackingIdentifier: "940000000000000000",
    })),
    voidLabel: vi.fn(async () => ({ shipmentId: "shp_1", version: 4 })),
    dispatchShipment: vi.fn(async () => ({ shipmentId: "shp_1", version: 4 })),
    deliverShipment: vi.fn(async () => ({ shipmentId: "shp_1", version: 5 })),
    returnShipment: vi.fn(async () => ({ shipmentId: "shp_1", version: 6 })),
    raiseShipmentException: vi.fn(async () => ({ shipmentId: "shp_1", version: 7 })),
    listBuyerShipments: vi.fn(async () => ({ items: [], total: 0 })),
    getBuyerShipment: vi.fn(async () => null),
    listSellerShipments: vi.fn(async () => ({ items: [], total: 0 })),
    getSellerShipment: vi.fn(async () => null),
    listSellerPackingSlips: vi.fn(
      async ({ shipmentIds }: { shipmentIds: readonly string[] }) =>
        shipmentIds.map((shipmentId) => ({
          shipment_id: shipmentId,
          order_id: "ord_1",
          buyer_account_id: "acc_buyer",
          buyer_display_name: "Buyer",
          seller_account_id: "acc_seller",
          seller_display_name: "Seller",
          shipping_option: "standard",
          shipping_plan_snapshot: null,
          shipping_destination_snapshot: {
            name: "Buyer",
            company: null,
            line1: "2 Market St",
            line2: null,
            city: "Chicago",
            state: "IL",
            postalCode: "60601",
            country: "US",
            phone: null,
            email: null,
          },
          shipping_origin_snapshot: {
            name: "Seller",
            company: null,
            line1: "1 Main St",
            line2: null,
            city: "Austin",
            state: "TX",
            postalCode: "78701",
            country: "US",
            phone: null,
            email: null,
          },
          shipping_method: null,
          carrier_name: null,
          label_reference: null,
          label_document_url: null,
          tracking_identifier: null,
          postage_provider_name: null,
          postage_provider_mode: null,
          postage_provider_shipment_id: null,
          postage_provider_label_id: null,
          postage_rate_id: null,
          postage_service_level: null,
          postage_amount_cents: null,
          postage_currency: null,
          label_status: "not-purchased",
          label_error_code: null,
          label_error_message: null,
          label_refund_status: null,
          label_refund_reference: null,
          status: "awaiting-package",
          package_status: "awaiting-package",
          package_count: null,
          current_exception_type: null,
          current_exception_notes: null,
          created_at: "2026-04-02T00:00:00.000Z",
          updated_at: "2026-04-02T00:00:00.000Z",
          packing_started_at: null,
          package_prepared_at: null,
          label_attached_at: null,
          label_voided_at: null,
          dispatched_at: null,
          delivered_at: null,
          returned_at: null,
          cancelled_at: null,
          exception_raised_at: null,
          line_count: 1,
          total_quantity: 1,
          lines: [
            {
              line_id: "spl_1",
              order_line_id: "oli_1",
              catalog_catalog_item_id: "cat_1",
              product_id: "cat_1::",
              item_title: "Charizard",
              item_subtitle: null,
              product_summary: "Condition: Near Mint",
              quantity: 1,
              packing_confirmed_at: null,
            },
          ],
          exceptions: [],
          address_override_audits: [],
        })) as never,
    ),
    projectors: [],
  };
}

describe("fulfillment shipment routes", () => {
  it("lists seller shipments for the current account", async () => {
    const services = createServices();
    const app = buildSellerApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["fulfillment.view", "fulfillment.manage"],
      },
      services,
    });

    const response = await app.fetch(new Request("http://fulfillment.test/account/sales/shipments"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [],
      total: 0,
      count: 0,
    });
    expect(services.listSellerShipments).toHaveBeenCalledWith({
      sellerAccountId: "acc_seller",
      limit: 50,
      offset: 0,
    });
  });

  it("rejects seller package updates without fulfillment manage permission", async () => {
    const app = buildSellerApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "viewer",
        permissions: ["fulfillment.view"],
      },
      services: createServices(),
    });

    const response = await app.fetch(
      new Request("http://fulfillment.test/account/sales/shipments/shp_1/pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageCount: 1 }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "authorization_forbidden",
        message: "Forbidden.",
      },
    });
  });

  it("returns packing slips for selected seller shipments", async () => {
    const services = createServices();
    const app = buildSellerApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["fulfillment.view"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://fulfillment.test/account/sales/shipments/packing-slips?shipmentIds=shp_1,shp_2"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.count).toBe(2);
    expect(body.items[0]).toMatchObject({
      shipment_id: "shp_1",
      order_id: "ord_1",
      lines: [
        expect.objectContaining({
          item_title: "Charizard",
          quantity: 1,
        }),
      ],
    });
    expect(JSON.stringify(body)).not.toContain("price");
    expect(JSON.stringify(body)).not.toContain("payment");
    expect(services.listSellerPackingSlips).toHaveBeenCalledWith({
      sellerAccountId: "acc_seller",
      shipmentIds: ["shp_1", "shp_2"],
    });
  });

  it("rejects packing slip batches without selected shipments", async () => {
    const services = createServices();
    const app = buildSellerApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["fulfillment.view"],
      },
      services,
    });

    const response = await app.fetch(new Request("http://fulfillment.test/account/sales/shipments/packing-slips"));

    expect(response.status).toBe(400);
    expect(services.listSellerPackingSlips).not.toHaveBeenCalled();
  });

  it("rejects packing slip batches without an authenticated seller", async () => {
    const services = createServices();
    const app = buildSellerApp({
      actor: null,
      services,
    });

    const response = await app.fetch(
      new Request("http://fulfillment.test/account/sales/shipments/packing-slips?shipmentIds=shp_1"),
    );

    expect(response.status).toBe(401);
    expect(services.listSellerPackingSlips).not.toHaveBeenCalled();
  });

  it("rejects packing slip batches without fulfillment view permission", async () => {
    const services = createServices();
    const app = buildSellerApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "viewer",
        permissions: [],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://fulfillment.test/account/sales/shipments/packing-slips?shipmentIds=shp_1"),
    );

    expect(response.status).toBe(403);
    expect(services.listSellerPackingSlips).not.toHaveBeenCalled();
  });

  it("rejects packing slip batches over one hundred shipments", async () => {
    const services = createServices();
    const app = buildSellerApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["fulfillment.view"],
      },
      services,
    });
    const shipmentIds = Array.from({ length: 101 }, (_, index) => `shp_${index}`).join(",");

    const response = await app.fetch(
      new Request(`http://fulfillment.test/account/sales/shipments/packing-slips?shipmentIds=${shipmentIds}`),
    );

    expect(response.status).toBe(400);
    expect(services.listSellerPackingSlips).not.toHaveBeenCalled();
  });

  it("drives the seller shipment lifecycle through documented API actions", async () => {
    const services = createServices();
    const app = buildSellerApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["fulfillment.view", "fulfillment.manage"],
      },
      services,
    });

    const startPackingResponse = await app.fetch(
      new Request("http://fulfillment.test/account/sales/shipments/shp_1/packing/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const packResponse = await app.fetch(
      new Request("http://fulfillment.test/account/sales/shipments/shp_1/packing/lines/spl_1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      }),
    );
    const completePackingResponse = await app.fetch(
      new Request("http://fulfillment.test/account/sales/shipments/shp_1/pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageCount: 1 }),
      }),
    );
    const labelResponse = await app.fetch(
      new Request("http://fulfillment.test/account/sales/shipments/shp_1/label", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shippingMethod: "standard",
          carrierName: "USPS",
          labelReference: "lbl_1",
          trackingIdentifier: "trk_1",
        }),
      }),
    );
    const dispatchResponse = await app.fetch(
      new Request("http://fulfillment.test/account/sales/shipments/shp_1/dispatch", {
        method: "POST",
      }),
    );
    const deliverResponse = await app.fetch(
      new Request("http://fulfillment.test/account/sales/shipments/shp_1/deliver", {
        method: "POST",
      }),
    );

    expect(startPackingResponse.status).toBe(200);
    await expect(startPackingResponse.json()).resolves.toEqual({
      id: "shp_1",
      version: 2,
      status: "packing",
    });
    expect(packResponse.status).toBe(200);
    await expect(packResponse.json()).resolves.toEqual({
      id: "shp_1",
      lineId: "spl_1",
      version: 3,
      confirmed: true,
    });
    expect(completePackingResponse.status).toBe(200);
    await expect(completePackingResponse.json()).resolves.toEqual({
      id: "shp_1",
      version: 2,
      status: "packed",
    });
    expect(labelResponse.status).toBe(200);
    await expect(labelResponse.json()).resolves.toEqual({
      id: "shp_1",
      version: 3,
      status: "label-attached",
    });
    expect(dispatchResponse.status).toBe(200);
    await expect(dispatchResponse.json()).resolves.toEqual({
      id: "shp_1",
      version: 4,
      status: "dispatched",
    });
    expect(deliverResponse.status).toBe(200);
    await expect(deliverResponse.json()).resolves.toEqual({
      id: "shp_1",
      version: 5,
      status: "delivered",
    });
    expect(services.packShipment).toHaveBeenCalledWith(
      {
        shipmentId: "shp_1",
        sellerAccountId: "acc_seller",
        packageCount: 1,
      },
      expect.any(Object),
    );
    expect(services.confirmPackingLine).toHaveBeenCalledWith(
      {
        shipmentId: "shp_1",
        sellerAccountId: "acc_seller",
        lineId: "spl_1",
      },
      expect.any(Object),
    );
    expect(services.startPackingShipment).toHaveBeenCalledWith(
      {
        shipmentId: "shp_1",
        sellerAccountId: "acc_seller",
      },
      expect.any(Object),
    );
    expect(services.attachLabel).toHaveBeenCalledWith(
      {
        shipmentId: "shp_1",
        sellerAccountId: "acc_seller",
        shippingMethod: "standard",
        carrierName: "USPS",
        labelReference: "lbl_1",
        trackingIdentifier: "trk_1",
      },
      expect.any(Object),
    );
    expect(services.dispatchShipment).toHaveBeenCalledWith(
      {
        shipmentId: "shp_1",
        sellerAccountId: "acc_seller",
      },
      expect.any(Object),
    );
    expect(services.deliverShipment).toHaveBeenCalledWith(
      {
        shipmentId: "shp_1",
        sellerAccountId: "acc_seller",
      },
      expect.any(Object),
    );
  });

  it("purchases a USPS label through the configured postage provider path", async () => {
    const services = createServices();
    const app = buildSellerApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["fulfillment.view", "fulfillment.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://fulfillment.test/account/sales/shipments/shp_1/label/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceLevel: "USPS_GROUND_ADVANTAGE",
          senderName: "Seller",
          senderStreet1: "1 Main St",
          senderCity: "Austin",
          senderState: "TX",
          senderPostalCode: "78701",
          senderCountry: "US",
          recipientName: "Buyer",
          recipientStreet1: "2 Market St",
          recipientCity: "Chicago",
          recipientState: "IL",
          recipientPostalCode: "60601",
          recipientCountry: "US",
          packageLengthInches: 7,
          packageWidthInches: 5,
          packageHeightInches: 1,
          packageWeightOunces: 4,
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "shp_1",
      version: 3,
      status: "label-attached",
      trackingIdentifier: "940000000000000000",
    });
    expect(services.purchaseUspsLabel).toHaveBeenCalledWith(
      {
        shipmentId: "shp_1",
        sellerAccountId: "acc_seller",
        serviceLevel: "USPS_GROUND_ADVANTAGE",
        overrideReason: null,
        sender: expect.objectContaining({
          name: "Seller",
          postalCode: "78701",
        }),
        recipient: expect.objectContaining({
          name: "Buyer",
          postalCode: "60601",
        }),
        package: {
          lengthInches: 7,
          widthInches: 5,
          heightInches: 1,
          weightOunces: 4,
        },
      },
      expect.any(Object),
    );
  });
});
