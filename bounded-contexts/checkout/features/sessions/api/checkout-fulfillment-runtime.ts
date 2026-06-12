import type { CheckoutSessionLine } from "../domain/domain";
import { CheckoutDomainError } from "../../../support/runtime-support/common";

export const unresolvedFulfillmentCode = "unresolved_fulfillment" as const;
export const unresolvedFulfillmentMessage = "Resolve item availability before checkout starts.";

export function unresolvedFulfillmentError() {
  return new CheckoutDomainError(unresolvedFulfillmentMessage, unresolvedFulfillmentCode);
}

export function checkoutLineHasAssignedFulfillment(line: CheckoutSessionLine) {
  const listingId = (line.lockedListingId ?? line.listingId ?? "").trim();
  return line.availabilityState === "available" && line.fulfillmentMode === "locked-listing" && listingId.length > 0;
}

export function assertCheckoutLinesHaveAssignedFulfillment(lines: readonly CheckoutSessionLine[]) {
  if (!lines.every(checkoutLineHasAssignedFulfillment)) {
    throw unresolvedFulfillmentError();
  }
}
