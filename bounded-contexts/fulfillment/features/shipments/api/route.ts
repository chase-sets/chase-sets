import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { FulfillmentApiEnv } from "../../../api";
import type { FulfillmentShipmentServices } from "./runtime";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { assertCanonicalShipmentMutationId } from "../domain/mutation-attempt";

const providerWebhookContext = {
  tenantId: "tnt_identity" as TenantId,
  audit: {
    performedByUserId: "usr_identity_system" as UserId,
    forAccountId: "acc_identity_system" as AccountId,
  },
} satisfies EventStoreContext;

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
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("fulfillment.features.shipments.api.route.authentication.required"),
          },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: { code: "authorization_forbidden", message: t("fulfillment.features.shipments.api.route.forbidden") },
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  return { actor, response: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("fulfillment.features.shipments.api.route.request.failed");
}

function isPostageWebhookVerificationError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return message.includes("signature") || message.includes("webhook secret") || message.includes("header");
}

function readAddress(body: Record<string, unknown>, prefix: string) {
  return {
    name: String(body[`${prefix}Name`] ?? ""),
    company: typeof body[`${prefix}Company`] === "string" ? String(body[`${prefix}Company`]) : null,
    street1: String(body[`${prefix}Street1`] ?? ""),
    street2: typeof body[`${prefix}Street2`] === "string" ? String(body[`${prefix}Street2`]) : null,
    city: String(body[`${prefix}City`] ?? ""),
    state: String(body[`${prefix}State`] ?? ""),
    postalCode: String(body[`${prefix}PostalCode`] ?? ""),
    country: String(body[`${prefix}Country`] ?? "US"),
    phone: typeof body[`${prefix}Phone`] === "string" ? String(body[`${prefix}Phone`]) : null,
    email: typeof body[`${prefix}Email`] === "string" ? String(body[`${prefix}Email`]) : null,
  };
}

function hasAddressInput(body: Record<string, unknown>, prefix: string) {
  return ["Name", "Company", "Street1", "Street2", "City", "State", "PostalCode", "Country", "Phone", "Email"].some(
    (field) => typeof body[`${prefix}${field}`] === "string",
  );
}

function readPackageInput(body: Record<string, unknown>) {
  const fields = ["packageLengthInches", "packageWidthInches", "packageHeightInches", "packageWeightOunces"];
  if (!fields.some((field) => body[field] !== undefined)) {
    return null;
  }
  return {
    lengthInches: Number(body.packageLengthInches),
    widthInches: Number(body.packageWidthInches),
    heightInches: Number(body.packageHeightInches),
    weightOunces: Number(body.packageWeightOunces),
  };
}

function parseShipmentIds(value: string | undefined) {
  return Array.from(
    new Set(
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function readMutationAttemptId(c: { req: { header(name: string): string | undefined } }) {
  const value = c.req.header("Idempotency-Key");
  assertCanonicalShipmentMutationId(value);
  return value;
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

    const shipment = await services.getBuyerShipment(c.req.param("id"), access.actor.accountId);
    if (!shipment) {
      return c.json(
        { error: { code: "not_found", message: t("fulfillment.features.shipments.api.route.shipment.not.found") } },
        404,
      );
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

  app.get("/sales/shipments/packing-slips", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.view");
    if (access.response) {
      return access.response;
    }

    const shipmentIds = parseShipmentIds(c.req.query("shipmentIds"));
    if (shipmentIds.length === 0) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: t("fulfillment.features.shipments.api.route.packing.slips.require.shipments"),
          },
        },
        400,
      );
    }
    if (shipmentIds.length > 100) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: t("fulfillment.features.shipments.api.route.packing.slips.too.many.shipments"),
          },
        },
        400,
      );
    }

    const items = await services.listSellerPackingSlips({
      sellerAccountId: access.actor.accountId,
      shipmentIds,
    });

    return c.json({
      items,
      count: items.length,
    });
  });

  app.get("/sales/shipments/:id", async (c) => {
    const access = requireShipmentAccess(c, "fulfillment.view");
    if (access.response) {
      return access.response;
    }

    const shipment = await services.getSellerShipment(c.req.param("id"), access.actor.accountId);
    if (!shipment) {
      return c.json(
        { error: { code: "not_found", message: t("fulfillment.features.shipments.api.route.shipment.not.found.2") } },
        404,
      );
    }

    return c.json(shipment);
  });

  app.get("/sales/shipments/:id/mutation-recovery", async (c) => {
    let mutationAttemptId: string;
    try {
      mutationAttemptId = readMutationAttemptId(c);
    } catch {
      return c.json(
        {
          error: {
            code: "invalid_idempotency_key",
            message: t("fulfillment.features.shipments.api.route.idempotency.key.required"),
          },
        },
        400,
      );
    }
    const access = requireShipmentAccess(c, "fulfillment.view");
    if (access.response) return access.response;
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("fulfillment.features.shipments.api.route.authentication.context.required"),
          },
        },
        401,
      );
    }
    try {
      return c.json(
        await services.recoverShipmentMutation(
          { shipmentId: c.req.param("id"), sellerAccountId: access.actor.accountId, mutationAttemptId },
          context,
        ),
      );
    } catch (error) {
      return c.json({ error: { code: "mutation_recovery_unavailable", message: errorMessage(error) } }, 409);
    }
  });

  app.post("/sales/shipments/:id/packing/start", async (c) => {
    let mutationAttemptId: string;
    try {
      mutationAttemptId = readMutationAttemptId(c);
    } catch {
      return c.json(
        {
          error: {
            code: "invalid_idempotency_key",
            message: t("fulfillment.features.shipments.api.route.idempotency.key.required"),
          },
        },
        400,
      );
    }
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("fulfillment.features.shipments.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    try {
      const result = await services.startPackingShipment(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
          mutationAttemptId,
        },
        context,
      );
      return c.json({ id: result.shipmentId, version: result.version, status: "packing" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sales/shipments/:id/packing/lines/:lineId", async (c) => {
    let mutationAttemptId: string;
    try {
      mutationAttemptId = readMutationAttemptId(c);
    } catch {
      return c.json(
        {
          error: {
            code: "invalid_idempotency_key",
            message: t("fulfillment.features.shipments.api.route.idempotency.key.required"),
          },
        },
        400,
      );
    }
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("fulfillment.features.shipments.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const confirmed = body.confirmed === true || body.confirmed === "true";
    const hasConfirmedQuantity = body.confirmedQuantity !== undefined;

    try {
      const result = hasConfirmedQuantity
        ? await services.setPackingLineQuantity(
            {
              shipmentId: c.req.param("id"),
              sellerAccountId: access.actor.accountId,
              lineId: c.req.param("lineId"),
              confirmedQuantity: Number(body.confirmedQuantity),
              mutationAttemptId,
            },
            context,
          )
        : confirmed
          ? await services.confirmPackingLine(
              {
                shipmentId: c.req.param("id"),
                sellerAccountId: access.actor.accountId,
                lineId: c.req.param("lineId"),
                mutationAttemptId,
              },
              context,
            )
          : await services.unconfirmPackingLine(
              {
                shipmentId: c.req.param("id"),
                sellerAccountId: access.actor.accountId,
                lineId: c.req.param("lineId"),
                mutationAttemptId,
              },
              context,
            );
      return c.json({
        id: result.shipmentId,
        lineId: c.req.param("lineId"),
        version: result.version,
        ...(hasConfirmedQuantity ? { confirmedQuantity: Number(body.confirmedQuantity) } : { confirmed }),
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sales/shipments/:id/pack", async (c) => {
    let mutationAttemptId: string;
    try {
      mutationAttemptId = readMutationAttemptId(c);
    } catch {
      return c.json(
        {
          error: {
            code: "invalid_idempotency_key",
            message: t("fulfillment.features.shipments.api.route.idempotency.key.required"),
          },
        },
        400,
      );
    }
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("fulfillment.features.shipments.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await services.packShipment(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
          packageCount: Number(body.packageCount ?? 1),
          mutationAttemptId,
        },
        context,
      );
      return c.json({ id: result.shipmentId, version: result.version, status: "packed" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sales/shipments/:id/label", async (c) => {
    let mutationAttemptId: string;
    try {
      mutationAttemptId = readMutationAttemptId(c);
    } catch {
      return c.json(
        {
          error: {
            code: "invalid_idempotency_key",
            message: t("fulfillment.features.shipments.api.route.idempotency.key.required"),
          },
        },
        400,
      );
    }
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("fulfillment.features.shipments.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
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
          mutationAttemptId,
        },
        context,
      );
      return c.json({ id: result.shipmentId, version: result.version, status: "label-attached" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sales/shipments/:id/label/purchase", async (c) => {
    let mutationAttemptId: string;
    try {
      mutationAttemptId = readMutationAttemptId(c);
    } catch {
      return c.json(
        {
          error: {
            code: "invalid_idempotency_key",
            message: t("fulfillment.features.shipments.api.route.idempotency.key.required"),
          },
        },
        400,
      );
    }
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("fulfillment.features.shipments.api.route.authentication.context.missing.3"),
          },
        },
        401,
      );
    }

    const body = (await c.req.json()) as Record<string, unknown>;

    try {
      const result = await services.purchaseUspsLabel(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
          serviceLevel: String(body.serviceLevel ?? "USPS_GROUND_ADVANTAGE"),
          sender: hasAddressInput(body, "sender") ? readAddress(body, "sender") : null,
          recipient: hasAddressInput(body, "recipient") ? readAddress(body, "recipient") : null,
          overrideReason: typeof body.overrideReason === "string" ? body.overrideReason : null,
          package: readPackageInput(body),
          mutationAttemptId,
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
    let mutationAttemptId: string;
    try {
      mutationAttemptId = readMutationAttemptId(c);
    } catch {
      return c.json(
        {
          error: {
            code: "invalid_idempotency_key",
            message: t("fulfillment.features.shipments.api.route.idempotency.key.required"),
          },
        },
        400,
      );
    }
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("fulfillment.features.shipments.api.route.authentication.context.missing.4"),
          },
        },
        401,
      );
    }

    try {
      const result = await services.voidLabel(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
          mutationAttemptId,
        },
        context,
      );
      return c.json({ id: result.shipmentId, version: result.version, status: "label-voided" });
    } catch (error) {
      return c.json({ error: { code: "label_void_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sales/shipments/:id/dispatch", async (c) => {
    let mutationAttemptId: string;
    try {
      mutationAttemptId = readMutationAttemptId(c);
    } catch {
      return c.json(
        {
          error: {
            code: "invalid_idempotency_key",
            message: t("fulfillment.features.shipments.api.route.idempotency.key.required"),
          },
        },
        400,
      );
    }
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("fulfillment.features.shipments.api.route.authentication.context.missing.5"),
          },
        },
        401,
      );
    }

    try {
      const result = await services.dispatchShipment(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
          mutationAttemptId,
        },
        context,
      );
      return c.json({ id: result.shipmentId, version: result.version, status: "dispatched" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sales/shipments/:id/deliver", async (c) => {
    let mutationAttemptId: string;
    try {
      mutationAttemptId = readMutationAttemptId(c);
    } catch {
      return c.json(
        {
          error: {
            code: "invalid_idempotency_key",
            message: t("fulfillment.features.shipments.api.route.idempotency.key.required"),
          },
        },
        400,
      );
    }
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("fulfillment.features.shipments.api.route.authentication.context.missing.6"),
          },
        },
        401,
      );
    }

    try {
      const result = await services.deliverShipment(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
          mutationAttemptId,
        },
        context,
      );
      return c.json({ id: result.shipmentId, version: result.version, status: "delivered" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sales/shipments/:id/return", async (c) => {
    let mutationAttemptId: string;
    try {
      mutationAttemptId = readMutationAttemptId(c);
    } catch {
      return c.json(
        {
          error: {
            code: "invalid_idempotency_key",
            message: t("fulfillment.features.shipments.api.route.idempotency.key.required"),
          },
        },
        400,
      );
    }
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("fulfillment.features.shipments.api.route.authentication.context.missing.7"),
          },
        },
        401,
      );
    }

    const body = await c.req.json().catch(() => ({}));

    try {
      const result = await services.returnShipment(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
          reason: typeof body.reason === "string" ? body.reason : null,
          mutationAttemptId,
        },
        context,
      );
      return c.json({ id: result.shipmentId, version: result.version, status: "return-recorded" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sales/shipments/:id/exception", async (c) => {
    let mutationAttemptId: string;
    try {
      mutationAttemptId = readMutationAttemptId(c);
    } catch {
      return c.json(
        {
          error: {
            code: "invalid_idempotency_key",
            message: t("fulfillment.features.shipments.api.route.idempotency.key.required"),
          },
        },
        400,
      );
    }
    const access = requireShipmentAccess(c, "fulfillment.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("fulfillment.features.shipments.api.route.authentication.context.missing.8"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await services.raiseShipmentException(
        {
          shipmentId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
          exceptionType: String(body.exceptionType ?? "other"),
          notes: typeof body.notes === "string" ? body.notes : null,
          mutationAttemptId,
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

export function createPostageProviderWebhookRoutes(services: FulfillmentShipmentServices) {
  const app = new Hono();

  app.post("/postage/webhooks", async (c) => {
    const rawBody = await c.req.text();
    const path = new URL(c.req.url).pathname;

    try {
      const result = await services.processPostageProviderWebhook(
        {
          rawBody,
          method: c.req.method,
          path,
          headers: c.req.raw.headers,
        },
        providerWebhookContext,
      );

      return c.json(result);
    } catch (error) {
      const verificationError = isPostageWebhookVerificationError(error);
      return c.json(
        {
          error: {
            code: verificationError ? "postage_webhook_rejected" : "postage_webhook_processing_failed",
            message: errorMessage(error),
          },
        },
        verificationError ? 400 : 500,
      );
    }
  });

  return app;
}
