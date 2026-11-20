import salvage from "./fixtures/tcgplayer-sealed-products.salvage.json" with { type: "json" };
import type { TcgplayerSealedProductDetail } from "../domain/extension/sealed-products/contract";
export { salvage };
export const sealedRoutePath = "/catalog-observations/tcgplayer-sealed-products";
export const sealedDetail = (): TcgplayerSealedProductDetail =>
  structuredClone(salvage.cases[0]!.detail) as TcgplayerSealedProductDetail;
export const sealedPost = () => ({
  contractVersion: 1 as const,
  observedAt: "2026-10-18T00:00:00.000Z",
  products: [sealedDetail()],
});
export const sealedRequest = (body: unknown) =>
  new Request(`http://localhost${sealedRoutePath}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
