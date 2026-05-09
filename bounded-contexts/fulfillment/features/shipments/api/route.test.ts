import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { FulfillmentApiEnv } from "../../../api";
import {
  createAccountShipmentRoutes,
  createAccountSaleShipmentRoutes,
} from "./route";
import type { FulfillmentShipmentServices } from "./runtime";

function buildSellerApp(options: Readonly<{
  actor: FulfillmentApiEnv["Variables"]["actor"];
  services: FulfillmentShipmentServices;
}>) {
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

    const response = await app.fetch(
      new Request("http://fulfillment.test/account/sales/shipments"),
    );

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

    const packResponse = await app.fetch(
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

    expect(packResponse.status).toBe(200);
    await expect(packResponse.json()).resolves.toEqual({
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
