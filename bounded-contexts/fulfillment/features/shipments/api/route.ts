import { Hono } from "hono";
import type { FulfillmentApiEnv } from "../../../api";
import type { FulfillmentShipmentServices } from "./runtime";

function requireShipmentAccess(
  c: {
    get(key: "actor"): FulfillmentApiEnv["Variables"]["actor"];
  },
  permission: "fulfillment.view" | "fulfillment.manage",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(JSON.stringify({ error: "Authentication required." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      response: new Response(JSON.stringify({ error: "Forbidden." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  return { actor, response: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

export function createAccountShipmentRoutes(services: FulfillmentShipmentServices) {
  const app = new Hono<FulfillmentApiEnv>();

  app.get("/shipments", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listBuyerShipments({
      buyerAccountId: access.actor.accountId,
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/shipments/:id", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.view");
    if (access.response) {
      return access.response;
    }

    const shipment = await services.getBuyerShipment(
      c.req.param("id"),
      access.actor.accountId,
    );
    if (!shipment) {
      return c.json({ error: "Shipment not found." }, 404);
    }

    return c.json(shipment);
  });

  return app;
}

export function createAccountSaleShipmentRoutes(services: FulfillmentShipmentServices) {
  const app = new Hono<FulfillmentApiEnv>();

  app.get("/sales/shipments", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listSellerShipments({
      sellerAccountId: access.actor.accountId,
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/sales/shipments/:id", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.view");
    if (access.response) {
      return access.response;
    }

    const shipment = await services.getSellerShipment(
      c.req.param("id"),
      access.actor.accountId,
    );
    if (!shipment) {
      return c.json({ error: "Shipment not found." }, 404);
    }

    return c.json(shipment);
  });

  app.post("/sales/shipments/:id/pack", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.packShipment(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
          packageCount: Number(body.packageCount ?? 1),
        },
        context,
      );
      return c.json({ id: result.shipmentId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/sales/shipments/:id/label", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.attachLabel(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
          shippingMethod: String(body.shippingMethod ?? "standard"),
          carrierName: String(body.carrierName ?? ""),
          labelReference: String(body.labelReference ?? ""),
          trackingIdentifier: String(body.trackingIdentifier ?? ""),
        },
        context,
      );
      return c.json({ id: result.shipmentId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/sales/shipments/:id/dispatch", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    try {
      const result = await services.dispatchShipment(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
        },
        context,
      );
      return c.json({ id: result.shipmentId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/sales/shipments/:id/deliver", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    try {
      const result = await services.deliverShipment(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
        },
        context,
      );
      return c.json({ id: result.shipmentId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/sales/shipments/:id/return", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json().catch(() => ({}));

    try {
      const result = await services.returnShipment(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
          reason:
            typeof body.reason === "string"
              ? body.reason
              : null,
        },
        context,
      );
      return c.json({ id: result.shipmentId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/sales/shipments/:id/exception", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.raiseShipmentException(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
          exceptionType: String(body.exceptionType ?? "other"),
          notes:
            typeof body.notes === "string"
              ? body.notes
              : null,
        },
        context,
      );
      return c.json({ id: result.shipmentId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return app;
}
