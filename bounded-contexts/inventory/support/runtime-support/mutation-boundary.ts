import type { MiddlewareHandler } from "hono";
import type { InventoryApiEnv } from "../../api";
import { assert } from "./common";
import { withInventoryMutationAttempt } from "./mutation-attempt";

const fields = {
  create: [
    "catalogItemId",
    "selectedOptions",
    "certificationNumber",
    "storageLocationId",
    "totalQuantity",
    "acquisitionCostAmount",
    "acquisitionCostCurrencyCode",
    "acquisitionOccurredAt",
  ],
  ensure: [
    "catalogItemId",
    "selectedOptions",
    "gradedCard",
    "quantity",
    "quantityCap",
    "shipFromCode",
    "shipFromAddress",
  ],
  adjust: [
    "quantityDelta",
    "reason",
    "reasonCode",
    "note",
    "collisionMode",
    "confirmSellerCannotFulfill",
    "acquisitionOccurredAt",
  ],
  hold: ["quantity", "reason", "notes"],
  location: ["name", "description", "shipFromCode", "shipFromAddress", "isArchived"],
  checkout: ["checkoutSessionId", "lineKey", "inventoryItemId", "sellerAccountId", "quantity", "reservationAttempt"],
  releaseCheckout: ["checkoutSessionId", "lineKey", "sellerAccountId"],
  restock: ["expectedVersion", "outcome", "damageNote"],
} as const;

function closed(value: unknown, allowed: readonly string[]) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "Invalid Inventory request.");
  const record = value as Record<string, unknown>;
  assert(
    Object.keys(record).every((key) => allowed.includes(key)),
    "Invalid Inventory request.",
  );
  return record;
}

export function validateInventoryMutationBody(value: unknown, allowed: readonly string[]) {
  const body = closed(value, allowed);
  if (allowed.includes("expectedVersion")) {
    assert(
      typeof body.expectedVersion === "number" &&
        Number.isSafeInteger(body.expectedVersion) &&
        body.expectedVersion > 0,
      "Invalid restock version.",
    );
    assert(body.outcome === "restocked" || body.outcome === "written-off", "Invalid restock outcome.");
    assert(
      body.damageNote === undefined || body.damageNote === null || typeof body.damageNote === "string",
      "Invalid restock note.",
    );
  }
  if (body.isArchived !== undefined) assert(typeof body.isArchived === "boolean", "Invalid archive flag.");
  if (body.certificationNumber !== undefined)
    assert(
      body.certificationNumber === null || typeof body.certificationNumber === "string",
      "Invalid certification number.",
    );
  if (body.selectedOptions !== undefined) {
    const options: unknown =
      typeof body.selectedOptions === "string" ? JSON.parse(body.selectedOptions) : body.selectedOptions;
    assert(Array.isArray(options), "Invalid selected options.");
    for (const option of options) closed(option, ["dimensionId", "optionId"]);
  }
  if (body.shipFromAddress != null)
    closed(body.shipFromAddress, [
      "name",
      "company",
      "line1",
      "line2",
      "city",
      "state",
      "postalCode",
      "country",
      "phone",
      "email",
    ]);
  if (body.gradedCard != null) {
    const card = closed(body.gradedCard, [
      "gradingCompany",
      "grade",
      "certificationNumber",
      "population",
      "conditionDescriptors",
    ]);
    if (card.population != null) closed(card.population, ["populationAtGrade", "populationHigher", "source", "asOf"]);
  }
}

export function inventoryMutationBoundary(): MiddlewareHandler<InventoryApiEnv> {
  return async (c, next) => {
    if (!["POST", "PATCH"].includes(c.req.method)) return next();
    const path = c.req.path.replace(/^\/api\/inventory/, "").replace(/\/$/, "");
    const allowed =
      path === "/items"
        ? fields.create
        : path === "/items/listing-stock/ensure"
          ? fields.ensure
          : /^\/items\/[^/]+\/adjustments$/.test(path)
            ? fields.adjust
            : /^\/items\/[^/]+\/holds$/.test(path)
              ? fields.hold
              : /^\/holds\/[^/]+\/release$/.test(path)
                ? []
                : /^\/storage-locations(?:\/[^/]+)?$/.test(path)
                  ? fields.location
                  : path === "/checkout-reservations"
                    ? fields.checkout
                    : /^\/checkout-reservations\/[^/]+\/release$/.test(path)
                      ? fields.releaseCheckout
                      : /^\/restock-decisions\/[^/]+\/decision$/.test(path)
                        ? fields.restock
                        : null;
    if (!allowed) return next();
    try {
      const actor = c.get("actor");
      const context = c.get("context");
      assert(actor?.accountId === context?.audit.forAccountId, "Inventory mutation is not authorized.");
      validateInventoryMutationBody(await c.req.json(), allowed);
      c.set("context", withInventoryMutationAttempt(context, c.req.header("Inventory-Mutation-Attempt") ?? ""));
    } catch {
      return c.json(
        { error: { code: "inventory_mutation_refused", message: "Inventory request was not accepted." } },
        400,
      );
    }
    await next();
  };
}
