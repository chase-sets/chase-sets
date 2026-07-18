import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { InventoryApiEnv } from "../../../api";
import type { InventoryHoldServices } from "../../holds/api/runtime";
import type { InventoryItemServices } from "./runtime";
import type { InventoryHoldCollisionServices } from "../../hold-collisions/api/runtime";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { parseGradedCardShape } from "./graded-card-shape";

function parseSelectedOptions(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((entry) =>
          entry && typeof entry === "object"
            ? {
                dimensionId: String((entry as Record<string, unknown>).dimensionId ?? ""),
                optionId: String((entry as Record<string, unknown>).optionId ?? ""),
              }
            : null,
        )
        .filter((entry): entry is { dimensionId: string; optionId: string } =>
          Boolean(entry?.dimensionId && entry.optionId),
        )
    : [];
}

function parseShipFromAddress(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const source = value as Record<string, unknown>;
  const hasRequiredFields = ["name", "line1", "city", "state", "postalCode", "country"].every(
    (key) => String(source[key] ?? "").trim().length > 0,
  );

  if (!hasRequiredFields) {
    return null;
  }

  return {
    name: String(source.name ?? ""),
    company: source.company == null ? null : String(source.company),
    line1: String(source.line1 ?? ""),
    line2: source.line2 == null ? null : String(source.line2),
    city: String(source.city ?? ""),
    state: String(source.state ?? ""),
    postalCode: String(source.postalCode ?? ""),
    country: String(source.country ?? "US"),
    phone: source.phone == null ? null : String(source.phone),
    email: source.email == null ? null : String(source.email),
  };
}

export function inventoryItemRoutes(
  items: InventoryItemServices,
  holds: InventoryHoldServices,
  holdCollisions: InventoryHoldCollisionServices,
) {
  const app = new Hono<InventoryApiEnv>();

  app.get("/", async (c) => {
    const actor = c.get("actor");
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await items.listItems({
      accountId: actor.accountId,
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
      limit,
      offset,
    });
  });

  app.get("/:id", async (c) => {
    const actor = c.get("actor");
    const item = await items.getItem(c.req.param("id"), actor.accountId);

    if (!item) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("inventory.features.inventoryItems.api.route.inventory.item.not.found"),
          },
        },
        404,
      );
    }

    return c.json(item);
  });

  app.post("/listing-stock/ensure", async (c) => {
    const actor = c.get("actor");
    const body = await c.req.json();

    try {
      const result = await items.ensureListingStock(
        {
          accountId: actor.accountId as AccountId,
          catalogItemId: String(body.catalogItemId ?? ""),
          selectedOptions: parseSelectedOptions(body.selectedOptions),
          gradedCard: parseGradedCardShape(body.gradedCard),
          quantity: Number(body.quantity ?? body.quantityCap ?? 0),
          shipFromCode: typeof body.shipFromCode === "string" ? body.shipFromCode : null,
          shipFromAddress: parseShipFromAddress(body.shipFromAddress),
        },
        c.get("context"),
      );

      return c.json(result, 201);
    } catch (error) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message:
              error instanceof Error ? error.message : t("inventory.features.inventoryItems.api.route.request.failed"),
          },
        },
        400,
      );
    }
  });

  app.post("/", async (c) => {
    const actor = c.get("actor");
    const body = await c.req.json();
    const result = await items.createItem(
      {
        accountId: actor.accountId as AccountId,
        catalogItemId: String(body.catalogItemId ?? ""),
        selectedOptions: body.selectedOptions,
        gradedCard: typeof body.gradedCard === "object" && body.gradedCard !== null ? body.gradedCard : null,
        storageLocationId: String(body.storageLocationId ?? ""),
        totalQuantity: Number(body.totalQuantity ?? 0),
        acquisitionCostAmount:
          body.acquisitionCostAmount === null ||
          typeof body.acquisitionCostAmount === "undefined" ||
          String(body.acquisitionCostAmount).trim() === ""
            ? null
            : String(body.acquisitionCostAmount),
      },
      c.get("context"),
    );

    return c.json({ id: result.itemId, version: result.version, status: "created" }, 201);
  });

  app.post("/:id/adjustments", async (c) => {
    const actor = c.get("actor");
    const body = await c.req.json();
    const quantityDelta = Number(body.quantityDelta ?? 0);
    const collisionMode = body.collisionMode ?? "protect-orders";
    if (collisionMode !== "protect-orders" && collisionMode !== "honor-offline") {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: t("inventory.features.inventoryItems.api.route.collision.mode.invalid"),
          },
        },
        400,
      );
    }
    if (collisionMode === "honor-offline" && quantityDelta >= 0) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: t("inventory.features.inventoryItems.api.route.honor.offline.reduction.required"),
          },
        },
        400,
      );
    }
    if (collisionMode === "honor-offline") {
      if (!actor.roleKey || !["manager", "owner", "platform-admin"].includes(actor.roleKey)) {
        return c.json(
          {
            error: {
              code: "authorization_forbidden",
              message: t("inventory.features.inventoryItems.api.route.honor.offline.authority.required"),
            },
          },
          403,
        );
      }
      if (body.confirmSellerCannotFulfill !== true) {
        return c.json(
          {
            error: {
              code: "honor_offline_confirmation_required",
              message: t("inventory.features.inventoryItems.api.route.honor.offline.confirmation.required"),
            },
          },
          400,
        );
      }
    }
    let result:
      | Awaited<ReturnType<InventoryItemServices["adjustItem"]>>
      | Awaited<ReturnType<InventoryHoldCollisionServices["reduceItem"]>>;
    try {
      result =
        quantityDelta < 0
          ? await holdCollisions.reduceItem(
              {
                accountId: actor.accountId,
                itemId: c.req.param("id"),
                requestedQuantity: -quantityDelta,
                reason: String(body.reason ?? ""),
                mode: collisionMode,
                honorOfflineAuthorized: collisionMode === "honor-offline",
              },
              c.get("context"),
            )
          : await items.adjustItem(
              {
                accountId: actor.accountId,
                itemId: c.req.param("id"),
                quantityDelta,
                reason: String(body.reason ?? ""),
              },
              c.get("context"),
            );
    } catch (error) {
      const committedUnits =
        error instanceof Error ? /^(\d+) units are committed to open orders\.$/.exec(error.message) : null;
      if (committedUnits) {
        return c.json(
          {
            error: {
              code: "inventory_adjustment_below_committed_quantity",
              message: t("inventory.features.inventoryItems.api.route.units.committed.to.open.orders", {
                count: committedUnits[1] ?? 0,
              }),
            },
          },
          400,
        );
      }
      throw error;
    }

    const collision = "collision" in result ? result.collision : null;
    return c.json({
      id: result.itemId,
      version: result.version,
      status: collision ? "hold-collision-recorded" : "adjusted",
      ...(collision
        ? {
            collision,
            message:
              collision.mode === "protect-orders"
                ? [
                    t("inventory.features.inventoryItems.api.route.protect.orders.refused", {
                      count: collision.refusedQuantity,
                    }),
                    collision.affectedOrders.length > 0
                      ? t("inventory.features.inventoryItems.api.route.protect.orders.affected", {
                          orders: [...new Set(collision.affectedOrders.map((order) => order.orderId))].join(", "),
                        })
                      : null,
                  ]
                    .filter((part): part is string => part !== null)
                    .join(" ")
                : t("inventory.features.inventoryItems.api.route.honor.offline.affected.orders", {
                    count: collision.affectedOrders.length,
                  }),
          }
        : {}),
    });
  });

  app.post("/:id/holds", async (c) => {
    const actor = c.get("actor");
    const body = await c.req.json();
    const result = await holds.createHold(
      {
        accountId: actor.accountId as AccountId,
        itemId: c.req.param("id"),
        quantity: Number(body.quantity ?? 0),
        reason: String(body.reason ?? ""),
        notes: typeof body.notes === "string" ? body.notes : null,
        purpose: "manual",
        sourceRef: null,
        expiresAt: null,
      },
      c.get("context"),
    );

    return c.json({ id: result.holdId, version: result.version, status: "placed" }, 201);
  });

  return app;
}
