import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CheckoutApiEnv } from "../../../api";
import type { CheckoutCartServices } from "./runtime";

function requireCartAccess(
  c: {
    get(key: "actor"): CheckoutApiEnv["Variables"]["actor"];
  },
  permission: "orders.view" | "orders.manage",
  options: Readonly<{ allowGuestCheckout?: boolean }> = {},
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(JSON.stringify({ error: { code: "authentication_required", message: t("checkout.features.cart.api.route.authentication.required") } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  if (!actor.permissions.includes(permission)) {
    if (
      options.allowGuestCheckout &&
      actor.permissions.includes("guest-checkout.manage")
    ) {
      return { actor, response: null };
    }

    return {
      actor: null,
      response: new Response(JSON.stringify({ error: { code: "authorization_forbidden", message: t("checkout.features.cart.api.route.forbidden") } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  return { actor, response: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("checkout.features.cart.api.route.request.failed");
}

function createGuestCheckoutContext() {
  return {
    tenantId: "tnt_identity",
    audit: {
      performedByUserId: "usr_guest_checkout",
      forAccountId: "acc_guest_checkout",
    },
    trace: {},
  } as never;
}

function parseVersionSelection(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter(
          (selection): selection is { dimensionId: string; optionId: string } =>
            Boolean(
              selection &&
              typeof selection === "object" &&
              "dimensionId" in selection &&
              "optionId" in selection,
            ),
        )
        .map((selection) => ({
          dimensionId: String(selection.dimensionId ?? ""),
          optionId: String(selection.optionId ?? ""),
        }))
    : [];
}

function parseFulfillmentMode(body: Record<string, unknown>) {
  const lockedListingId =
    body.lockedListingId === null || body.lockedListingId === undefined
      ? null
      : String(body.lockedListingId).trim() || null;
  return {
    fulfillmentMode:
      body.fulfillmentMode === "locked-listing" || lockedListingId
        ? "locked-listing" as const
        : "optimize" as const,
    lockedListingId,
    sellerPreferenceId:
      body.sellerPreferenceId === null || body.sellerPreferenceId === undefined
        ? null
        : String(body.sellerPreferenceId).trim() || null,
  };
}

function countCartItems(items: readonly { quantity: number }[]) {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

export function createAccountCartRoutes(services: CheckoutCartServices) {
  const app = new Hono<CheckoutApiEnv>();

  app.get("/cart", async (c) => {
    const access = requireCartAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    const items = await services.listCartLines(access.actor.accountId);
    return c.json({
      items,
      count: countCartItems(items),
    });
  });

  app.post("/cart", async (c) => {
    const access = requireCartAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("checkout.features.cart.api.route.authentication.context.missing") } }, 401);
    }

    const body = await c.req.json();
    const fulfillment = parseFulfillmentMode(body);

    try {
      const result = await services.addLine(
        {
          accountId: access.actor.accountId as never,
          catalogItemId: String(body.catalogItemId ?? ""),
          productId: String(body.productId ?? ""),
          itemTitle: String(body.itemTitle ?? ""),
            itemSubtitle:
              body.itemSubtitle === null || body.itemSubtitle === undefined
                ? null
                : String(body.itemSubtitle),
            itemImageUrl:
              body.itemImageUrl === null || body.itemImageUrl === undefined
                ? null
                : String(body.itemImageUrl),
            selectedOptions: parseVersionSelection(body.selectedOptions),
          productSummary:
            body.productSummary === null || body.productSummary === undefined
              ? null
              : String(body.productSummary),
          quantity: Number(body.quantity ?? 0),
          ...fulfillment,
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "added" }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/:lineId/quantity", async (c) => {
    const access = requireCartAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("checkout.features.cart.api.route.authentication.context.missing.2") } }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.setLineQuantity(
        {
          accountId: access.actor.accountId as never,
          lineId: c.req.param("lineId") as never,
          quantity: Number(body.quantity ?? 0),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "quantity-updated" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/:lineId/fulfillment", async (c) => {
    const access = requireCartAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("checkout.features.cart.api.route.authentication.context.missing.2") } }, 401);
    }

    const body = await c.req.json();
    const fulfillment = parseFulfillmentMode(body);

    try {
      const result = await services.setLineFulfillment(
        {
          accountId: access.actor.accountId as never,
          lineId: c.req.param("lineId") as never,
          availabilityState:
            body.availabilityState === "unavailable" ||
            body.availabilityState === "changed" ||
            body.availabilityState === "waiting-for-supply"
              ? body.availabilityState
              : "available",
          ...fulfillment,
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "fulfillment-updated" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/:lineId/remove", async (c) => {
    const access = requireCartAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("checkout.features.cart.api.route.authentication.context.missing.3") } }, 401);
    }

    try {
      const result = await services.removeLine(
        {
          accountId: access.actor.accountId as never,
          lineId: c.req.param("lineId") as never,
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "removed" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}

function requireAnonymousCartId(c: { req: { header: (name: string) => string | undefined } }) {
  const ownerId = c.req.header("x-checkout-anonymous-cart-id")?.trim() ?? "";
  if (!ownerId.startsWith("anon_")) {
    return null;
  }

  return ownerId;
}

export function createGuestCartRoutes(services: CheckoutCartServices) {
  const app = new Hono<CheckoutApiEnv>();

  app.get("/cart", async (c) => {
    const ownerId = requireAnonymousCartId(c);
    if (!ownerId) {
      return c.json({ items: [], count: 0 });
    }

    const items = await services.listCartLines(ownerId);
    return c.json({ items, count: countCartItems(items) });
  });

  app.post("/cart", async (c) => {
    const ownerId = requireAnonymousCartId(c);
    if (!ownerId) {
      return c.json({ error: { code: "anonymous_cart_required", message: t("checkout.features.cart.api.route.authentication.required") } }, 400);
    }

    const context = c.get("context") ?? createGuestCheckoutContext();

    const body = await c.req.json();
    const fulfillment = parseFulfillmentMode(body);

    try {
      const result = await services.addLine(
        {
          accountId: ownerId as never,
          catalogItemId: String(body.catalogItemId ?? ""),
          productId: String(body.productId ?? ""),
          itemTitle: String(body.itemTitle ?? ""),
            itemSubtitle:
              body.itemSubtitle === null || body.itemSubtitle === undefined
                ? null
                : String(body.itemSubtitle),
            itemImageUrl:
              body.itemImageUrl === null || body.itemImageUrl === undefined
                ? null
                : String(body.itemImageUrl),
            selectedOptions: parseVersionSelection(body.selectedOptions),
          productSummary:
            body.productSummary === null || body.productSummary === undefined
              ? null
              : String(body.productSummary),
          quantity: Number(body.quantity ?? 0),
          ...fulfillment,
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "added" }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/:lineId/quantity", async (c) => {
    const ownerId = requireAnonymousCartId(c);
    if (!ownerId) {
      return c.json({ error: { code: "anonymous_cart_required", message: t("checkout.features.cart.api.route.authentication.required") } }, 400);
    }

    const context = c.get("context") ?? createGuestCheckoutContext();
    const body = await c.req.json();

    try {
      const result = await services.setLineQuantity(
        {
          accountId: ownerId as never,
          lineId: c.req.param("lineId") as never,
          quantity: Number(body.quantity ?? 0),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "quantity-updated" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/:lineId/fulfillment", async (c) => {
    const ownerId = requireAnonymousCartId(c);
    if (!ownerId) {
      return c.json({ error: { code: "anonymous_cart_required", message: t("checkout.features.cart.api.route.authentication.required") } }, 400);
    }

    const context = c.get("context") ?? createGuestCheckoutContext();
    const body = await c.req.json();
    const fulfillment = parseFulfillmentMode(body);

    try {
      const result = await services.setLineFulfillment(
        {
          accountId: ownerId as never,
          lineId: c.req.param("lineId") as never,
          availabilityState:
            body.availabilityState === "unavailable" ||
            body.availabilityState === "changed" ||
            body.availabilityState === "waiting-for-supply"
              ? body.availabilityState
              : "available",
          ...fulfillment,
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "fulfillment-updated" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/:lineId/remove", async (c) => {
    const ownerId = requireAnonymousCartId(c);
    if (!ownerId) {
      return c.json({ error: { code: "anonymous_cart_required", message: t("checkout.features.cart.api.route.authentication.required") } }, 400);
    }

    const context = c.get("context") ?? createGuestCheckoutContext();

    try {
      const result = await services.removeLine(
        {
          accountId: ownerId as never,
          lineId: c.req.param("lineId") as never,
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "removed" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/merge-to-account", async (c) => {
    const access = requireCartAccess(c, "orders.manage", {
      allowGuestCheckout: true,
    });
    if (access.response) {
      return access.response;
    }

    const ownerId = requireAnonymousCartId(c);
    if (!ownerId) {
      return c.json({ mergedLineCount: 0 });
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "context_required", message: t("checkout.features.cart.api.route.authentication.context.missing.2") } }, 401);
    }

    const result = await services.mergeCartIntoAccount(
      {
        sourceOwnerId: ownerId,
        targetAccountId: access.actor.accountId as never,
      },
      context,
    );

    return c.json(result);
  });

  return app;
}
