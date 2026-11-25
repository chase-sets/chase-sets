import { closed, safeInteger } from "../protocol";
import { sealedProductLines, type SealedRequest } from "./collector";
export type SealedRequestMessage = { action: "fetch-sealed-products"; request: SealedRequest };
export function isSealedRequestMessage(value: unknown): value is SealedRequestMessage {
  if (!closed(value, ["action", "request"]) || value.action !== "fetch-sealed-products") return false;
  const request = value.request;
  if (closed(request, ["endpoint", "productId"]))
    return (
      request.endpoint === "detail" &&
      safeInteger(request.productId) &&
      request.productId > 0 &&
      request.productId <= 2_147_483_647
    );
  return (
    closed(request, ["endpoint", "productLineId", "setName", "from", "includeProductLine"]) &&
    request.endpoint === "search" &&
    sealedProductLines().some((line) => line.id === request.productLineId) &&
    typeof request.setName === "string" &&
    request.setName.length > 0 &&
    request.setName.length <= 512 &&
    safeInteger(request.from) &&
    request.from < 12_000 &&
    request.from % 24 === 0 &&
    typeof request.includeProductLine === "boolean"
  );
}
