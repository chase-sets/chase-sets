import { FulfillmentDomainError, assert, assertNever } from "../../shipments/domain/common";

export { FulfillmentDomainError, assert, assertNever };

/**
 * Lifecycle stages of a buyer-to-platform reverse shipment.
 *
 * The happy path advances monotonically through the delivery stages
 * (`requested` → `ready-to-ship` → `carrier-accepted` → `in-transit` →
 * `delivered` → `received`). `delivered` (the carrier handed the parcel to the
 * facility address) and `received` (the facility acknowledged intake) are kept as
 * separate facts: a carrier "delivered" scan is not a custody handoff.
 *
 * `cancelled` and `expired` are terminal off-ramps reachable only before the
 * parcel is in carrier custody. Carrier exceptions are modelled as an overlay
 * (see {@link ReturnShipmentExceptionType}), not a lifecycle stage, so a lost or
 * delayed scan never regresses the furthest stage the parcel has reached.
 */
export type ReturnShipmentStatus =
  | "requested"
  | "ready-to-ship"
  | "carrier-accepted"
  | "in-transit"
  | "delivered"
  | "received"
  | "cancelled"
  | "expired";

/**
 * Monotonic rank of each delivery stage. Carrier milestones only advance the
 * status when their target rank exceeds the current rank, so duplicate and
 * out-of-order carrier events converge without regressing custody state. Terminal
 * off-ramps are not ranked; they are guarded explicitly.
 */
export const returnShipmentDeliveryStageRanks: Readonly<Record<string, number>> = {
  requested: 0,
  "ready-to-ship": 1,
  "carrier-accepted": 2,
  "in-transit": 3,
  delivered: 4,
  received: 5,
};

export function returnShipmentDeliveryStageRank(status: ReturnShipmentStatus | null): number {
  if (status === null) {
    return -1;
  }
  return returnShipmentDeliveryStageRanks[status] ?? -1;
}

export function isTerminalReturnShipmentStatus(status: ReturnShipmentStatus | null): boolean {
  return status === "received" || status === "cancelled" || status === "expired";
}

/** A carrier or facility exception on a reverse shipment. */
export const returnShipmentExceptionTypes = [
  "carrier-delay",
  "lost-in-transit",
  "damaged-in-transit",
  "delivery-failed",
  "unscannable-label",
  "abandoned",
  "other",
] as const;

export type ReturnShipmentExceptionType = (typeof returnShipmentExceptionTypes)[number];

export function isReturnShipmentExceptionType(value: string): value is ReturnShipmentExceptionType {
  return (returnShipmentExceptionTypes as readonly string[]).includes(value);
}

export function normalizeReturnShipmentExceptionType(value: string): ReturnShipmentExceptionType {
  const normalized = value.trim().toLowerCase();
  if (!isReturnShipmentExceptionType(normalized)) {
    throw new FulfillmentDomainError(
      "Return shipment exception type must be carrier-delay, lost-in-transit, damaged-in-transit, delivery-failed, unscannable-label, abandoned, or other.",
    );
  }
  return normalized;
}

/** Who is accountable for the reverse-shipping cost. Settlement owns the ledger; Fulfillment only records the payer. */
export const returnShipmentCostPayers = ["platform", "seller", "buyer"] as const;

export type ReturnShipmentCostPayer = (typeof returnShipmentCostPayers)[number];

export function isReturnShipmentCostPayer(value: string): value is ReturnShipmentCostPayer {
  return (returnShipmentCostPayers as readonly string[]).includes(value);
}

export function normalizeReturnShipmentCostPayer(value: string): ReturnShipmentCostPayer {
  const normalized = value.trim().toLowerCase();
  if (!isReturnShipmentCostPayer(normalized)) {
    throw new FulfillmentDomainError("Return shipment cost payer must be platform, seller, or buyer.");
  }
  return normalized;
}

/** Provider status of the reverse-shipment carrier label. */
export const returnShipmentLabelStatuses = ["pending", "ready", "voided", "failed"] as const;

export type ReturnShipmentLabelStatus = (typeof returnShipmentLabelStatuses)[number];

/**
 * Machine-readable, closed taxonomy of why a return-label purchase failed. Support
 * surfaces these directly (they are actionable, not free-form provider text), so the
 * set intentionally names each failure scenario a buyer-to-platform label can hit.
 */
export const returnShipmentLabelFailureReasons = [
  "invalid-return-linkage",
  "invalid-buyer-address",
  "no-eligible-facility",
  "unsupported-parcel",
  "provider-timeout",
  "duplicate-authorization",
  "expired-directive",
  "label-purchase-rejected",
  "secure-document-storage-failure",
  "policy-cancelled",
  "provider-error",
] as const;

export type ReturnShipmentLabelFailureReason = (typeof returnShipmentLabelFailureReasons)[number];

export function isReturnShipmentLabelFailureReason(value: string): value is ReturnShipmentLabelFailureReason {
  return (returnShipmentLabelFailureReasons as readonly string[]).includes(value);
}

export function normalizeReturnShipmentLabelFailureReason(value: string): ReturnShipmentLabelFailureReason {
  const normalized = value.trim().toLowerCase();
  if (!isReturnShipmentLabelFailureReason(normalized)) {
    throw new FulfillmentDomainError(
      "Return shipment label failure reason must be a recognized machine-readable code.",
    );
  }
  return normalized;
}

/** Ensures a non-negative integer cents amount, or null when the provider does not report a cost. */
export function normalizeOptionalCents(value: number | null | undefined, message: string): number | null {
  if (value == null) {
    return null;
  }
  assert(Number.isInteger(value) && value >= 0, message);
  return value;
}

export function normalizeRequiredText(value: string, message: string): string {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

export function normalizeOptionalText(value?: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function ensureIsoTimestamp(value: string, message: string): string {
  const normalized = normalizeRequiredText(value, message);
  assert(!Number.isNaN(Date.parse(normalized)), message);
  return normalized;
}
