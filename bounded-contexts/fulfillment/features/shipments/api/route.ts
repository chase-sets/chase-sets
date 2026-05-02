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
      response: new Response(JSON.stringify({ error: { code: "authentication_required", message: "Authentication required." } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      response: new Response(JSON.stringify({ error: { code: "authorization_forbidden", message: "Forbidden." } }), {
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

function readAddress(body: Record<string, unknown>, prefix: string) {
  return {
    name: String(body[`${prefix}Name`] ?? ""),
    company:
      typeof body[`${prefix}Company`] === "string"
        ? String(body[`${prefix}Company`])
        : null,
    street1: String(body[`${prefix}Street1`] ?? ""),
    street2:
      typeof body[`${prefix}Street2`] === "string"
        ? String(body[`${prefix}Street2`])
        : null,
    city: String(body[`${prefix}City`] ?? ""),
    state: String(body[`${prefix}State`] ?? ""),
    postalCode: String(body[`${prefix}PostalCode`] ?? ""),
    country: String(body[`${prefix}Country`] ?? "US"),
    phone:
      typeof body[`${prefix}Phone`] === "string"
        ? String(body[`${prefix}Phone`])
        : null,
    email:
      typeof body[`${prefix}Email`] === "string"
        ? String(body[`${prefix}Email`])
        : null,
  };
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
      return c.json({ error: { code: "not_found", message: "Shipment not found." } }, 404);
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
      return c.json({ error: { code: "not_found", message: "Shipment not found." } }, 404);
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
      return c.json({ error: { code: "authentication_required", message: "Authentication context missing." } }, 401);
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
      return c.json({ id: result.shipmentId, version: result.version, status: "packed" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sales/shipments/:id/label", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: "Authentication context missing." } }, 401);
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
      return c.json({ id: result.shipmentId, version: result.version, status: "label-attached" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sales/shipments/:id/label/purchase", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: "Authentication context missing." } }, 401);
    }

    const body = await c.req.json() as Record<string, unknown>;

    try {
      const result = await services.purchaseUspsLabel(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
          serviceLevel: String(body.serviceLevel ?? "USPS_GROUND_ADVANTAGE"),
          sender: readAddress(body, "sender"),
          recipient: readAddress(body, "recipient"),
          package: {
            lengthInches: Number(body.packageLengthInches ?? 7),
            widthInches: Number(body.packageWidthInches ?? 5),
            heightInches: Number(body.packageHeightInches ?? 1),
            weightOunces: Number(body.packageWeightOunces ?? 4),
          },
        },
        context,
      );
      return c.json({
        id: result.shipmentId,
        version: result.version,
        status: "label-attached",
        trackingIdentifier: result.trackingIdentifier,
      });
    } catch (error) {
      return c.json({ error: { code: "label_purchase_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sales/shipments/:id/label/void", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: "Authentication context missing." } }, 401);
    }

    try {
      const result = await services.voidLabel(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
        },
        context,
      );
      return c.json({ id: result.shipmentId, version: result.version, status: "label-voided" });
    } catch (error) {
      return c.json({ error: { code: "label_void_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sales/shipments/:id/dispatch", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: "Authentication context missing." } }, 401);
    }

    try {
      const result = await services.dispatchShipment(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
        },
        context,
      );
      return c.json({ id: result.shipmentId, version: result.version, status: "dispatched" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sales/shipments/:id/deliver", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: "Authentication context missing." } }, 401);
    }

    try {
      const result = await services.deliverShipment(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
        },
        context,
      );
      return c.json({ id: result.shipmentId, version: result.version, status: "delivered" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sales/shipments/:id/return", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: "Authentication context missing." } }, 401);
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
      return c.json({ id: result.shipmentId, version: result.version, status: "return-recorded" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sales/shipments/:id/exception", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: "Authentication context missing." } }, 401);
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
      return c.json({ id: result.shipmentId, version: result.version, status: "exception-raised" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}
