import type { TypedUlid } from "@chase-sets/primitives/typed-ids";

export type ShipmentStatus =
  | "awaiting-package"
  | "packing"
  | "awaiting-label"
  | "label-attached"
  | "cancelled"
  | "dispatched"
  | "delivered"
  | "returned"
  | "exception";

export type PackageStatus = "awaiting-package" | "packing" | "packed";

export type ShipmentExceptionType =
  | "carrier-delay"
  | "damaged-package"
  | "lost-in-transit"
  | "return-to-sender"
  | "other";

export type ShippingMethod = "standard" | "expedited" | "priority" | "insured";

export type PostageLabelStatus = "not-purchased" | "purchased" | "void-requested" | "voided" | "purchase-error";

export type ShipmentLineId = TypedUlid<"spl">;

export class FulfillmentDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FulfillmentDomainError";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new FulfillmentDomainError(message);
  }
}

export function assertNever(value: never): never {
  throw new FulfillmentDomainError(`Unhandled variant: ${JSON.stringify(value)}`);
}

export function normalizeRequiredText(value: string, message: string) {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

export function normalizeOptionalText(value?: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function ensureIsoTimestamp(value: string, message: string) {
  const normalized = normalizeRequiredText(value, message);
  assert(!Number.isNaN(Date.parse(normalized)), message);
  return normalized;
}

export function ensurePositiveInteger(value: number, message: string) {
  assert(Number.isInteger(value) && value > 0, message);
  return value;
}

export function ensureNonNegativeInteger(value: number, message: string) {
  assert(Number.isInteger(value) && value >= 0, message);
  return value;
}

export function normalizeShippingMethod(value: string): ShippingMethod {
  const normalized = normalizeRequiredText(value, "Shipping method is required.").toLowerCase();

  switch (normalized) {
    case "standard":
    case "expedited":
    case "priority":
    case "insured":
      return normalized;
    default:
      throw new FulfillmentDomainError("Shipping method must be standard, expedited, priority, or insured.");
  }
}

export function normalizeShipmentExceptionType(value: string): ShipmentExceptionType {
  const normalized = normalizeRequiredText(value, "Shipment exception type is required.").toLowerCase();

  switch (normalized) {
    case "carrier-delay":
    case "damaged-package":
    case "lost-in-transit":
    case "return-to-sender":
    case "other":
      return normalized;
    default:
      throw new FulfillmentDomainError(
        "Shipment exception type must be carrier-delay, damaged-package, lost-in-transit, return-to-sender, or other.",
      );
  }
}
