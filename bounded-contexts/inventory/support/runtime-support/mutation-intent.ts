import { createHash } from "node:crypto";
import { normalizeMoneyAmount } from "@chase-sets/primitives/money";
import { InventoryDomainError, assert, normalizeOptionalText } from "./common";

export const inventoryMutationFamilies = [
  "item-create",
  "item-adjust",
  "listing-stock-ensure",
  "hold-create",
  "hold-release",
  "location-create",
  "location-update",
  "location-archive",
  "restock-record",
  "import-create",
  "import-resolve-row",
  "import-commit",
  "import-commit-row",
] as const;
export type InventoryMutationFamily = (typeof inventoryMutationFamilies)[number];
export type InventoryMutationIntent = Readonly<Record<string, unknown>>;

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "Inventory mutation input must be an object.",
  );
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (!fields.includes(key)) throw new InventoryDomainError(`Unknown Inventory mutation field: ${key}.`);
  }
  return result;
}

function text(value: unknown): string {
  assert(typeof value === "string", "Inventory mutation text is required.");
  return value.trim();
}

function optionalText(value: unknown): string | null {
  assert(value === undefined || value === null || typeof value === "string", "Inventory mutation text is invalid.");
  return normalizeOptionalText(value);
}

function integer(value: unknown, minimum?: number): number {
  assert(
    typeof value === "number" && Number.isSafeInteger(value),
    "Inventory mutation quantity must be a safe integer.",
  );
  assert(minimum === undefined || value >= minimum, "Inventory mutation quantity is invalid.");
  return value;
}

function instant(value: unknown): string {
  assert(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    "Inventory mutation time must be a timezone-bearing RFC3339 instant.",
  );
  const fractional = /\.(\d{1,9})(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? "";
  const whole = new Date(value.replace(/\.\d{1,9}(?=Z|[+-]\d{2}:\d{2}$)/, "")).toISOString().slice(0, 19);
  const precision = fractional.padEnd(9, "0").replace(/0+$/, "");
  return `${whole}${precision ? `.${precision}` : ""}Z`;
}

function occurrence(value: unknown) {
  if (value === undefined) return { kind: "unknown" };
  const input = object(value, ["kind", "occurredAt", "source"]);
  if (input.kind === "unknown") {
    object(value, ["kind"]);
    return { kind: "unknown" };
  }
  assert(
    input.kind === "occurred" && ["seller-supplied", "import-supplied"].includes(String(input.source)),
    "Inventory acquisition occurrence is invalid.",
  );
  return { kind: "occurred", occurredAt: instant(input.occurredAt), source: input.source };
}

function options(value: unknown) {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new InventoryDomainError("Inventory selected options are invalid.");
    }
  }
  assert(Array.isArray(value), "Inventory selected options must be an array.");
  const result = value
    .map((entry: unknown) => {
      const option = object(entry, ["dimensionId", "optionId"]);
      return { dimensionId: text(option.dimensionId), optionId: text(option.optionId) };
    })
    .sort((a, b) => (a.dimensionId < b.dimensionId ? -1 : a.dimensionId > b.dimensionId ? 1 : 0));
  assert(
    new Set(result.map((entry) => entry.dimensionId)).size === result.length,
    "Duplicate selected option dimension.",
  );
  return result;
}

function graded(value: unknown) {
  if (value === null || value === undefined) return null;
  const input = object(value, ["gradingCompany", "grade", "certificationNumber", "population", "conditionDescriptors"]);
  const population =
    input.population === null || input.population === undefined
      ? null
      : object(input.population, ["populationAtGrade", "populationHigher", "source", "asOf"]);
  assert(Array.isArray(input.conditionDescriptors), "Graded condition descriptors must be an array.");
  return {
    gradingCompany: text(input.gradingCompany),
    grade: text(input.grade),
    certificationNumber: optionalText(input.certificationNumber),
    population: population
      ? {
          populationAtGrade: population.populationAtGrade === null ? null : integer(population.populationAtGrade, 0),
          populationHigher: population.populationHigher === null ? null : integer(population.populationHigher, 0),
          source: optionalText(population.source),
          asOf: optionalText(population.asOf),
        }
      : null,
    conditionDescriptors: [...new Set(input.conditionDescriptors.map(text).filter(Boolean))].sort(),
  };
}

function address(value: unknown, allowVerification = true): InventoryMutationIntent {
  const input = object(value, [
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
    ...(allowVerification ? ["verification"] : []),
  ]);
  let verification: InventoryMutationIntent | null = null;
  if (input.verification !== null && input.verification !== undefined) {
    const checked = object(input.verification, [
      "status",
      "source",
      "checkedAt",
      "buyerDecision",
      "suggestedAddress",
      "messages",
    ]);
    assert(
      ["verified", "corrected", "unverified", "undeliverable"].includes(String(checked.status)),
      "Address verification status is invalid.",
    );
    assert(
      checked.buyerDecision === null ||
        checked.buyerDecision === undefined ||
        ["accepted-suggested", "kept-original", "provider-unavailable"].includes(String(checked.buyerDecision)),
      "Address verification decision is invalid.",
    );
    assert(
      checked.messages === undefined || Array.isArray(checked.messages),
      "Address verification messages must be an array.",
    );
    verification = {
      status: checked.status,
      source: optionalText(checked.source) ?? "unknown",
      checkedAt: instant(checked.checkedAt === undefined ? new Date(0).toISOString() : checked.checkedAt),
      buyerDecision: checked.buyerDecision ?? null,
      suggestedAddress: checked.suggestedAddress == null ? null : address(checked.suggestedAddress, false),
      messages: checked.messages === undefined ? [] : checked.messages.map(text).filter(Boolean),
    };
  }
  return {
    name: text(input.name),
    company: optionalText(input.company),
    line1: text(input.line1),
    line2: optionalText(input.line2),
    city: text(input.city),
    state: text(input.state),
    postalCode: text(input.postalCode),
    country: text(input.country).toUpperCase(),
    phone: optionalText(input.phone),
    email: optionalText(input.email),
    ...(allowVerification ? { verification } : {}),
  };
}

export function normalizeInventoryMutationIntent(
  family: InventoryMutationFamily,
  value: unknown,
): InventoryMutationIntent {
  switch (family) {
    case "import-create": {
      const input = object(value, ["accountId", "snapshotVersion", "snapshotHash"]);
      assert(
        input.snapshotVersion === 1 &&
          typeof input.snapshotHash === "string" &&
          /^[a-f0-9]{64}$/.test(input.snapshotHash),
        "Invalid Inventory import snapshot intent.",
      );
      return { accountId: text(input.accountId), snapshotVersion: 1, snapshotHash: input.snapshotHash };
    }
    case "import-commit": {
      const input = object(value, ["accountId", "batchId"]);
      return { accountId: text(input.accountId), batchId: text(input.batchId) };
    }
    case "import-resolve-row": {
      const input = object(value, [
        "accountId",
        "batchId",
        "rowId",
        "expectedRowVersion",
        "expectedRowFingerprint",
        "catalogItemId",
        "selectedOptions",
        "storageLocationId",
      ]);
      assert(
        input.expectedRowVersion === undefined || typeof input.expectedRowVersion === "string",
        "Invalid import row version.",
      );
      assert(
        input.expectedRowFingerprint === undefined || typeof input.expectedRowFingerprint === "string",
        "Invalid import row fingerprint.",
      );
      return {
        accountId: text(input.accountId),
        batchId: text(input.batchId),
        rowId: text(input.rowId),
        expectedRowVersion: input.expectedRowVersion ?? null,
        expectedRowFingerprint: input.expectedRowFingerprint ?? null,
        catalogItemId: text(input.catalogItemId),
        selectedOptions: options(input.selectedOptions),
        storageLocationId: text(input.storageLocationId),
      };
    }
    case "import-commit-row": {
      const input = object(value, ["accountId", "batchId", "rowId", "claimToken"]);
      return {
        accountId: text(input.accountId),
        batchId: text(input.batchId),
        rowId: text(input.rowId),
        claimToken: text(input.claimToken),
      };
    }
    case "restock-record": {
      const input = object(value, ["accountId", "decisionId", "expectedVersion", "outcome", "damageNote"]);
      assert(input.outcome === "restocked" || input.outcome === "written-off", "Unsupported restock outcome.");
      return {
        accountId: text(input.accountId),
        decisionId: text(input.decisionId),
        expectedVersion: integer(input.expectedVersion, 1),
        outcome: input.outcome,
        damageNote: optionalText(input.damageNote),
      };
    }
    case "item-create": {
      const input = object(value, [
        "accountId",
        "catalogItemId",
        "selectedOptions",
        "gradedCard",
        "storageLocationId",
        "totalQuantity",
        "acquisitionCostAmount",
        "acquisitionCostCurrencyCode",
        "acquisitionOccurrence",
        "itemIdOverride",
      ]);
      assert(
        (input.acquisitionCostAmount == null) === (input.acquisitionCostCurrencyCode == null),
        "Acquisition cost amount and currency must be supplied together.",
      );
      return {
        accountId: text(input.accountId),
        catalogItemId: text(input.catalogItemId),
        selectedOptions: options(input.selectedOptions),
        gradedCard: graded(input.gradedCard),
        storageLocationId: text(input.storageLocationId),
        totalQuantity: integer(input.totalQuantity, 0),
        acquisitionCostAmount:
          input.acquisitionCostAmount == null ? null : normalizeMoneyAmount(text(input.acquisitionCostAmount)),
        acquisitionCostCurrencyCode:
          input.acquisitionCostCurrencyCode == null ? null : text(input.acquisitionCostCurrencyCode),
        acquisitionOccurrence: occurrence(input.acquisitionOccurrence),
        itemIdOverride: input.itemIdOverride ?? null,
      };
    }
    case "item-adjust": {
      const input = object(value, [
        "accountId",
        "itemId",
        "quantityDelta",
        "requestedQuantity",
        "reason",
        "reasonCode",
        "note",
        "sourceRef",
        "acquisitionOccurrence",
        "idempotencyKey",
        "mode",
        "actorRole",
        "offlineSale",
      ]);
      assert(input.idempotencyKey == null, "Inventory attempts replace adjustment idempotency keys on cut-over paths.");
      const reduction = input.requestedQuantity !== undefined;
      assert(!reduction || input.quantityDelta === undefined, "Inventory adjustment must have one quantity intent.");
      const delta = reduction ? -integer(input.requestedQuantity, 1) : integer(input.quantityDelta);
      const sourceInput =
        input.sourceRef == null
          ? null
          : object(input.sourceRef, ["orderId", "reservationRequestId", "checkoutSessionId", "lineKey"]);
      const source =
        sourceInput === null
          ? null
          : sourceInput.orderId !== undefined
            ? {
                orderId: text(object(sourceInput, ["orderId", "reservationRequestId"]).orderId),
                reservationRequestId: text(sourceInput.reservationRequestId),
              }
            : {
                checkoutSessionId: text(object(sourceInput, ["checkoutSessionId", "lineKey"]).checkoutSessionId),
                lineKey: text(sourceInput.lineKey),
              };
      const sale =
        input.offlineSale === undefined
          ? undefined
          : object(input.offlineSale, ["channel", "salePriceAmount", "idempotencyKey"]);
      return {
        operation: reduction ? "reduction" : "adjustment",
        accountId: text(input.accountId),
        itemId: text(input.itemId),
        quantityDelta: delta,
        reason: text(input.reason),
        ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
        ...(input.note !== undefined ? { note: optionalText(input.note) } : {}),
        sourceRef: source,
        ...(delta > 0 ? { acquisitionOccurrence: occurrence(input.acquisitionOccurrence) } : {}),
        ...(reduction
          ? {
              mode: input.mode ?? "protect-orders",
              actorRole: input.actorRole ?? null,
              ...(sale
                ? {
                    offlineSale: {
                      channel: sale.channel,
                      idempotencyKey: text(sale.idempotencyKey),
                      salePriceAmount:
                        sale.salePriceAmount == null ? null : normalizeMoneyAmount(text(sale.salePriceAmount)),
                    },
                  }
                : {}),
            }
          : {}),
      };
    }
    case "hold-create": {
      const input = object(value, [
        "holdId",
        "accountId",
        "itemId",
        "quantity",
        "reason",
        "notes",
        "purpose",
        "sourceRef",
        "expiresAt",
      ]);
      const source =
        input.sourceRef == null
          ? null
          : object(
              input.sourceRef,
              input.purpose === "order" ? ["orderId", "reservationRequestId"] : ["checkoutSessionId", "lineKey"],
            );
      return {
        holdId: input.holdId ?? null,
        accountId: text(input.accountId),
        itemId: text(input.itemId),
        quantity: integer(input.quantity, 1),
        reason: text(input.reason),
        notes: optionalText(input.notes),
        purpose: input.purpose,
        sourceRef: source,
        expiresAt: input.expiresAt == null ? null : instant(input.expiresAt),
      };
    }
    case "hold-release": {
      const input = object(value, ["accountId", "holdId", "releaseReason"]);
      return { accountId: text(input.accountId), holdId: text(input.holdId), releaseReason: input.releaseReason };
    }
    case "listing-stock-ensure": {
      const input = object(value, [
        "accountId",
        "catalogItemId",
        "selectedOptions",
        "gradedCard",
        "quantity",
        "shipFromCode",
        "shipFromAddress",
      ]);
      return {
        accountId: text(input.accountId),
        catalogItemId: text(input.catalogItemId),
        selectedOptions: options(input.selectedOptions),
        gradedCard: graded(input.gradedCard),
        quantity: integer(input.quantity, 1),
        shipFromCode: optionalText(input.shipFromCode),
        shipFromAddress: input.shipFromAddress == null ? null : address(input.shipFromAddress),
      };
    }
    case "location-create":
    case "location-update":
    case "location-archive": {
      const input = object(value, [
        "accountId",
        "storageLocationId",
        "name",
        "description",
        "shipFromCode",
        "shipFromAddress",
        "isArchived",
      ]);
      assert(
        input.isArchived === undefined || typeof input.isArchived === "boolean",
        "Inventory archive flag must be boolean.",
      );
      return {
        accountId: text(input.accountId),
        ...(family !== "location-create" ? { storageLocationId: text(input.storageLocationId) } : {}),
        name: text(input.name),
        description: optionalText(input.description),
        shipFromCode: text(input.shipFromCode),
        shipFromAddress: address(input.shipFromAddress),
        ...(family !== "location-create" ? { isArchived: input.isArchived ?? false } : {}),
      };
    }
  }
  throw new InventoryDomainError("Inventory mutation family is not supported.");
}

export function inventoryMutationFingerprint(value: unknown): string {
  const canonical = (entry: unknown): string => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return JSON.stringify(entry);
    if (typeof entry === "number" && Number.isFinite(entry)) return JSON.stringify(entry);
    if (Array.isArray(entry)) return `[${entry.map(canonical).join(",")}]`;
    if (typeof entry === "object" && entry !== null && Object.getPrototypeOf(entry) === Object.prototype) {
      return `{${Object.entries(entry)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
    }
    throw new InventoryDomainError("Inventory mutation intent must be canonical JSON.");
  };
  return createHash("sha256")
    .update(`inventory-intent/v1\n${canonical(value)}`)
    .digest("hex");
}
