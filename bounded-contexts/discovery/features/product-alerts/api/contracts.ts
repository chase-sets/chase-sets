import type { ProductAlertMarketSide } from "../domain/domain";
import type { ProductAlertPageRow } from "../read-model/queries";

export type ProductAlertListResponse = Readonly<{
  items: readonly ProductAlertPageRow[];
  total: number;
  count: number;
}>;

export type CreateProductAlertRequest = Readonly<{
  marketSide: ProductAlertMarketSide;
  catalogItemId: string;
  productId: string;
  selectedOptions?: readonly { dimensionId: string; optionId: string }[];
  productSummary?: string | null;
  thresholdAmount?: string | null;
}>;
