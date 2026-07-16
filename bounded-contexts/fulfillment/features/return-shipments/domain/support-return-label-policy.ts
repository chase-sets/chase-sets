import type { RemedyId, ReturnShipmentId, SupportRequestId } from "@chase-sets/primitives/typed-ids";
import { FulfillmentDomainError } from "./common";

const sellerFaultFlows = new Set([
  "product-not-as-described",
  "product-damaged",
  "wrong-product-received",
  "authenticity-concern",
]);

export function returnLabelCostPayerForFlow(flowType: string): "seller" | "buyer" {
  if (sellerFaultFlows.has(flowType)) return "seller";
  if (flowType === "return-request") return "buyer";
  throw new FulfillmentDomainError(`Support flow '${flowType}' does not authorize an automatic return label.`);
}

function typedSuffix(supportRequestId: string): string {
  const suffix = supportRequestId.trim().replace(/^sup_/, "");
  if (!suffix) throw new FulfillmentDomainError("Support request id is required for return-label issuance.");
  return suffix;
}

export function returnShipmentIdForSupportRequest(supportRequestId: SupportRequestId | string): ReturnShipmentId {
  return `rsh_${typedSuffix(supportRequestId)}` as ReturnShipmentId;
}

export function returnLabelRemedyIdForSupportRequest(supportRequestId: SupportRequestId | string): RemedyId {
  return `rmd_${typedSuffix(supportRequestId)}` as RemedyId;
}
