import { sealedDetail } from "../../sealed-product-observation-fixture";
import { response } from "../set-names/fixture";
export { response };
export const detail = () => sealedDetail();
export const selection = () => {
  const value = detail();
  return { productLineId: value.productLineId, setId: value.setId, setName: value.setName };
};
export const product = (productId = 1, sealed = false) => ({
  ...detail(),
  setUrlName: "synthetic",
  productId,
  sealed,
  productTypeName: sealed ? "Booster" : "Card",
});
export const page = (from: number, totalResults: number, sealedId = totalResults) => ({
  errors: [],
  results: [
    {
      totalResults,
      resultId: "synthetic",
      results: Array.from({ length: Math.min(24, totalResults - from) }, (_, index) =>
        product(from + index + 1, from + index + 1 === sealedId),
      ),
    },
  ],
});
export const counts = { recorded: 1, changed: 1, unchanged: 0, candidateCount: 1, exclusions: [] };
