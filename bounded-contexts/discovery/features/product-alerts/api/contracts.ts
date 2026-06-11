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

export interface AnonymousProductAlertIntent {
  intent_id: string;
  anonymous_owner_id: string;
  source_path: string;
  market_side: ProductAlertMarketSide;
  catalog_item_id: string;
  product_id: string;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  threshold_amount: string | null;
  status: "active" | "claimed" | "expired";
  claimed_account_id: string | null;
  claimed_alert_id: string | null;
  claimed_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export type CreateAnonymousProductAlertIntentRequest = CreateProductAlertRequest &
  Readonly<{
    sourcePath: string;
  }>;
