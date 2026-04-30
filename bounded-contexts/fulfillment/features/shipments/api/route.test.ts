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
    await expect(response.json()).resolves.toEqual({ error: "Forbidden." });
  });
});
