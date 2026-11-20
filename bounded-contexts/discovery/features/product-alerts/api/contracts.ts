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
  thresholdCurrencyCode?: string | null;
  /**
   * One deliberate create, drawn with the form that sends it. The same attempt with the same
   * request is the same alert, so a resend (a double click, a resend after a lost answer, a
   * resubmitted form) answers the alert the first send created instead of creating another.
   */
  attemptId?: string | null;
}>;

/** An attempt id a create takes. */
export const PRODUCT_ALERT_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

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
  threshold_currency_code: string | null;
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
