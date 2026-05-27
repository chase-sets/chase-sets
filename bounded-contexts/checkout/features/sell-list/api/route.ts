import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CheckoutApiEnv } from "../../../api";
import type { CheckoutSellListServices } from "./runtime";

function requireSellListAccess(c: { get(key: "actor"): CheckoutApiEnv["Variables"]["actor"] }) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  if (actor.permissions.includes("guest-checkout.manage")) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authorization_forbidden",
            message: t("checkout.features.sellList.api.route.sell.list.review.requires.seller.account"),
          },
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

function createGuestSellListContext() {
  return {
    tenantId: "tnt_identity",
    audit: {
      performedByUserId: "usr_anonymous_sell_list",
      forAccountId: "acc_anonymous_sell_list",
    },
    trace: {},
  } as never;
}

function requireAnonymousSellListId(c: { req: { header: (name: string) => string | undefined } }) {
  const ownerId = c.req.header("x-checkout-anonymous-sell-list-id")?.trim() ?? "";
  if (!ownerId.startsWith("anon_")) {
    return null;
  }

  return ownerId;
}

function parseVersionSelection(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((selection): selection is { dimensionId: string; optionId: string } =>
          Boolean(selection && typeof selection === "object" && "dimensionId" in selection && "optionId" in selection),
        )
        .map((selection) => ({
          dimensionId: String(selection.dimensionId ?? ""),
          optionId: String(selection.optionId ?? ""),
        }))
    : [];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("checkout.features.sellList.api.route.sell.list.request.failed");
}

function parseSellListLineBody(body: Record<string, unknown>) {
  return {
    lineType: body.lineType === "selected-offer" ? ("selected-offer" as const) : ("product" as const),
    offerId: body.offerId === null || body.offerId === undefined ? null : String(body.offerId),
    buyerAccountId:
      body.buyerAccountId === null || body.buyerAccountId === undefined ? null : String(body.buyerAccountId),
    buyerDisplayName:
      body.buyerDisplayName === null || body.buyerDisplayName === undefined ? null : String(body.buyerDisplayName),
    offerPriceAmount:
      body.offerPriceAmount === null || body.offerPriceAmount === undefined ? null : String(body.offerPriceAmount),
    catalogItemId: String(body.catalogItemId ?? ""),
    productId: String(body.productId ?? ""),
    itemTitle: String(body.itemTitle ?? ""),
    itemSubtitle: body.itemSubtitle === null || body.itemSubtitle === undefined ? null : String(body.itemSubtitle),
    selectedOptions: parseVersionSelection(body.selectedOptions),
    productSummary:
      body.productSummary === null || body.productSummary === undefined ? null : String(body.productSummary),
    quantity: Number(body.quantity ?? 0),
    fallbackMode: body.fallbackMode === "create-listing" ? ("create-listing" as const) : ("none" as const),
    minimumListingPriceAmount:
      body.minimumListingPriceAmount === null || body.minimumListingPriceAmount === undefined
        ? null
        : String(body.minimumListingPriceAmount),
  };
}

export function createAccountSellListRoutes(services: CheckoutSellListServices) {
  const app = new Hono<CheckoutApiEnv>();

  app.get("/sell-list", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const items = await services.listLines(access.actor.accountId);
    return c.json({
      items,
      count: items.reduce((sum, item) => sum + item.quantity, 0),
    });
  });

  app.post("/sell-list", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("checkout.features.cart.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json<Record<string, unknown>>();

    try {
      const result = await services.addLine(
        {
          sellerAccountId: access.actor.accountId as never,
          ...parseSellListLineBody(body),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: result.status }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sell-list/:lineId/remove", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("checkout.features.cart.api.route.authentication.context.missing.3"),
          },
        },
        401,
      );
    }

    try {
      const result = await services.removeLine(
        {
          sellerAccountId: access.actor.accountId as never,
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

export function createGuestSellListRoutes(services: CheckoutSellListServices) {
  const app = new Hono<CheckoutApiEnv>();

  app.get("/sell-list", async (c) => {
    const ownerId = requireAnonymousSellListId(c);
    if (!ownerId) {
      return c.json({ items: [], count: 0 });
    }

    const items = await services.listLines(ownerId);
    return c.json({
      items,
      count: items.reduce((sum, item) => sum + item.quantity, 0),
    });
  });

  app.post("/sell-list", async (c) => {
    const ownerId = requireAnonymousSellListId(c);
    if (!ownerId) {
      return c.json(
        {
          error: {
            code: "anonymous_sell_list_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        },
        400,
      );
    }

    const context = c.get("context") ?? createGuestSellListContext();
    const body = await c.req.json<Record<string, unknown>>();

    try {
      const result = await services.addLine(
        {
          sellerAccountId: ownerId as never,
          ...parseSellListLineBody(body),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: result.status }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sell-list/:lineId/remove", async (c) => {
    const ownerId = requireAnonymousSellListId(c);
    if (!ownerId) {
      return c.json(
        {
          error: {
            code: "anonymous_sell_list_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        },
        400,
      );
    }

    const context = c.get("context") ?? createGuestSellListContext();

    try {
      const result = await services.removeLine(
        {
          sellerAccountId: ownerId as never,
          lineId: c.req.param("lineId") as never,
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "removed" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/sell-list/merge-to-account", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const ownerId = requireAnonymousSellListId(c);
    if (!ownerId) {
      return c.json({ mergedLineCount: 0 });
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "context_required",
            message: t("checkout.features.cart.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    const result = await services.mergeSellListIntoAccount(
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
