import salvage from "./fixtures/tcgplayer-sealed-products.salvage.json" with { type: "json" };
import type { TcgplayerSealedProductDetail } from "../domain/extension/sealed-products/contract";
import { operatorOrigins } from "../domain/extension/protocol";
import { sealedPartHeader } from "../domain/extension/sealed-products/answer-contract";
import { setNameRequestHeader } from "../domain/extension/set-names/request";
export { salvage };
export const sealedRoutePath = "/catalog-observations/tcgplayer-sealed-products";
export const sealedRequestId = "00000000-0000-4000-8000-000000000011";
export const sealedPartHeaders = { [sealedPartHeader]: "0", [setNameRequestHeader]: sealedRequestId };
export const sealedDetail = (): TcgplayerSealedProductDetail =>
  structuredClone(salvage.cases[0]!.detail) as TcgplayerSealedProductDetail;
export const sealedPost = () => ({
  contractVersion: 1 as const,
  observedAt: "2026-10-18T00:00:00.000Z",
  products: [sealedDetail()],
});
export const sealedRequest = (body: unknown) =>
  new Request(`${operatorOrigins.staging}${sealedRoutePath}`, {
    method: "POST",
    headers: sealedPartHeaders,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
