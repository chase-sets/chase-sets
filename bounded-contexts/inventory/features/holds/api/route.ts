import { Hono } from "hono";
import { createHash } from "node:crypto";
import { t } from "@chase-sets/localization";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import type { InventoryApiEnv } from "../../../api";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import { withInventorySystemHoldReleaseAuthority, type InventoryHoldServices } from "./runtime";
import type { AccountId, CheckoutSessionId } from "@chase-sets/primitives/typed-ids";
import type { InventoryHoldId } from "../../../support/runtime-support/common";

const CHECKOUT_RESERVATION_TTL_MS = 15 * 60 * 1000;
const CHECKOUT_RESERVATION_EXTENSION_MS = 5 * 60 * 1000;
const CHECKOUT_RESERVATION_EXTENSION_CAP = 3;
const CHECKOUT_RESERVATION_ATTEMPT_SEARCH_LIMIT = 25;

type InventoryHoldReadModel = NonNullable<Awaited<ReturnType<InventoryHoldServices["getHold"]>>>;

function checkoutReservationHoldId(
  input: Readonly<{
    checkoutSessionId: string;
    lineKey: string;
    inventoryItemId: string;
    reservationAttempt: number;
  }>,
) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        schema: "inventory.checkout-reservation.v1",
        checkoutSessionId: input.checkoutSessionId,
        lineKey: input.lineKey,
        inventoryItemId: input.inventoryItemId,
        ...(input.reservationAttempt > 1 ? { reservationAttempt: input.reservationAttempt } : {}),
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return parseTypedId(`hld_checkout_${digest}`, "hld");
}

function checkoutReservationExpiresAt(now = new Date()) {
  return new Date(now.getTime() + CHECKOUT_RESERVATION_TTL_MS).toISOString();
}

function checkoutReservationExtensionExpiresAt(now = new Date()) {
  return new Date(now.getTime() + CHECKOUT_RESERVATION_EXTENSION_MS).toISOString();
}

function normalizeCheckoutReservationAttempt(value: unknown) {
  const parsed = Number(value ?? 1);
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : 1;
}

function checkoutReservationMatches(
  hold: InventoryHoldReadModel,
  input: Readonly<{
    checkoutSessionId: string;
    lineKey: string;
    inventoryItemId: string;
    quantity: number;
  }>,
) {
  return (
    hold.purpose === "checkout" &&
    hold.item_id === input.inventoryItemId &&
    hold.quantity === input.quantity &&
    hold.source_ref &&
    "checkoutSessionId" in hold.source_ref &&
    hold.source_ref.checkoutSessionId === input.checkoutSessionId &&
    hold.source_ref.lineKey === input.lineKey
  );
}

function checkoutReservationIsCurrent(hold: InventoryHoldReadModel, nowMs: number) {
  const expiresAtMs = Date.parse(hold.expires_at ?? "");
  return hold.status === "active" && Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

export function inventoryHoldRoutes(services: InventoryHoldServices) {
  const app = new Hono<InventoryApiEnv>();

  app.post("/:id/release", async (c) => {
    const actor = c.get("actor");
    let result: Awaited<ReturnType<InventoryHoldServices["releaseHold"]>>;
    try {
      result = await services.releaseHold(
        {
          accountId: actor.accountId,
          holdId: parseTypedIdBoundary(c.req.param("id"), "hld", "holdId"),
          releaseReason: "manual",
        },
        c.get("context"),
      );
    } catch (error) {
      if (
        error instanceof InventoryDomainError &&
        error.message === "Only manual inventory holds can be released by sellers."
      ) {
        return c.json(
          {
            error: {
              code: "inventory_hold_not_seller_releasable",
              message: t("inventory.features.holds.api.route.only.manual.holds.can.be.released.by.sellers"),
            },
          },
          400,
        );
      }
      throw error;
    }

    return c.json({
      id: result.holdId,
      version: result.version,
    });
  });

  return app;
}

export function inventoryCheckoutReservationRoutes(services: InventoryHoldServices) {
  const app = new Hono<InventoryApiEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const checkoutSessionId = parseTypedIdBoundary(body.checkoutSessionId, "chk", "checkoutSessionId");
    const lineKey = String(body.lineKey ?? "").trim();
    const inventoryItemId = parseTypedIdBoundary(body.inventoryItemId, "inv", "inventoryItemId");
    const sellerAccountId = parseTypedIdBoundary(body.sellerAccountId, "acc", "sellerAccountId");
    const quantity = Number(body.quantity ?? 0);
    const reservationAttempt = normalizeCheckoutReservationAttempt(body.reservationAttempt);
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = checkoutReservationExpiresAt(now);

    try {
      await services.expireDueCheckoutHolds({ now: nowIso, limit: 100 }, c.get("context"));

      let holdId: InventoryHoldId | null = null;
      for (
        let attempt = reservationAttempt;
        attempt < reservationAttempt + CHECKOUT_RESERVATION_ATTEMPT_SEARCH_LIMIT;
        attempt += 1
      ) {
        const candidateHoldId = checkoutReservationHoldId({
          checkoutSessionId,
          lineKey,
          inventoryItemId,
          reservationAttempt: attempt,
        });
        const existing = await services.getHold(candidateHoldId, sellerAccountId);
        if (!existing) {
          holdId = candidateHoldId;
          break;
        }

        if (
          checkoutReservationMatches(existing, { checkoutSessionId, lineKey, inventoryItemId, quantity }) &&
          checkoutReservationIsCurrent(existing, now.getTime())
        ) {
          return c.json({
            holdId: existing.hold_id,
            sellerAccountId,
            inventoryItemId,
            lineKey,
            quantity: existing.quantity,
            expiresAt: existing.expires_at,
            extensionCount: existing.extension_count,
            status: "active",
          });
        }

        if (existing.status === "active") {
          throw new InventoryDomainError("Checkout reservation already exists for different stock.");
        }
      }
      if (!holdId) {
        throw new InventoryDomainError("Checkout reservation attempts are exhausted.");
      }

      const result = await services.createHold(
        {
          holdId,
          accountId: sellerAccountId,
          itemId: inventoryItemId,
          quantity,
          reason: "Checkout reservation",
          notes: null,
          purpose: "checkout",
          sourceRef: {
            checkoutSessionId,
            lineKey,
          },
          expiresAt,
        },
        c.get("context"),
      );

      return c.json(
        {
          holdId: result.holdId,
          sellerAccountId,
          inventoryItemId,
          lineKey,
          quantity,
          expiresAt,
          extensionCount: 0,
          status: "active",
        },
        201,
      );
    } catch (error) {
      return c.json(
        {
          error: {
            code:
              error instanceof Error && error.message.includes("available quantity")
                ? "checkout_reservation_unavailable"
                : "validation_failed",
            message: error instanceof Error ? error.message : "Checkout reservation failed.",
          },
        },
        409,
      );
    }
  });

  app.post("/:id/extend", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sellerAccountId = String(body.sellerAccountId ?? "").trim();
    const expiresAt = checkoutReservationExtensionExpiresAt();

    try {
      const result = await services.extendCheckoutHold(
        {
          accountId: sellerAccountId,
          holdId: c.req.param("id"),
          expiresAt,
          maxExtensionCount: CHECKOUT_RESERVATION_EXTENSION_CAP,
        },
        c.get("context"),
      );

      const hold = await services.getHold(result.holdId, sellerAccountId);
      return c.json({
        holdId: result.holdId,
        sellerAccountId,
        inventoryItemId: hold?.item_id ?? null,
        lineKey:
          hold?.source_ref && "lineKey" in hold.source_ref ? hold.source_ref.lineKey : String(body.lineKey ?? ""),
        quantity: hold?.quantity ?? null,
        expiresAt,
        extensionCount: hold?.extension_count ?? null,
        status: "active",
      });
    } catch (error) {
      return c.json(
        {
          error: {
            code: "checkout_reservation_extension_unavailable",
            message: error instanceof Error ? error.message : "Checkout reservation extension failed.",
          },
        },
        409,
      );
    }
  });

  app.post("/:id/release", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sellerAccountId = String(body.sellerAccountId ?? "").trim();
    const holdId = c.req.param("id");

    try {
      const existing = await services.getHold(holdId, sellerAccountId);
      if (!existing) {
        throw new InventoryDomainError("Inventory hold not found.");
      }
      if (existing.purpose !== "checkout") {
        throw new InventoryDomainError(
          "Only checkout inventory holds can be released through checkout reservation routes.",
        );
      }
      if (existing.status === "released" && existing.release_reason === "checkout-cancelled") {
        return c.json({
          holdId,
          sellerAccountId,
          inventoryItemId: existing.item_id,
          lineKey:
            existing.source_ref && "lineKey" in existing.source_ref
              ? existing.source_ref.lineKey
              : String(body.lineKey ?? ""),
          quantity: existing.quantity,
          expiresAt: existing.expires_at,
          extensionCount: existing.extension_count,
          status: "released",
        });
      }
      if (existing.status !== "active") {
        return c.json({
          holdId,
          sellerAccountId,
          inventoryItemId: existing.item_id,
          lineKey:
            existing.source_ref && "lineKey" in existing.source_ref
              ? existing.source_ref.lineKey
              : String(body.lineKey ?? ""),
          quantity: existing.quantity,
          expiresAt: existing.expires_at,
          extensionCount: existing.extension_count,
          status: existing.status,
        });
      }

      const result = await services.releaseHold(
        {
          accountId: sellerAccountId,
          holdId,
          releaseReason: "checkout-cancelled",
        },
        withInventorySystemHoldReleaseAuthority(c.get("context")),
      );
      const released = await services.getHold(result.holdId, sellerAccountId);

      return c.json({
        holdId: result.holdId,
        sellerAccountId,
        inventoryItemId: released?.item_id ?? existing.item_id,
        lineKey:
          released?.source_ref && "lineKey" in released.source_ref
            ? released.source_ref.lineKey
            : existing.source_ref && "lineKey" in existing.source_ref
              ? existing.source_ref.lineKey
              : String(body.lineKey ?? ""),
        quantity: released?.quantity ?? existing.quantity,
        expiresAt: released?.expires_at ?? existing.expires_at,
        extensionCount: released?.extension_count ?? existing.extension_count,
        status: "released",
      });
    } catch (error) {
      return c.json(
        {
          error: {
            code: "checkout_reservation_release_unavailable",
            message: error instanceof Error ? error.message : "Checkout reservation release failed.",
          },
        },
        409,
      );
    }
  });

  return app;
}
