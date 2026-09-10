import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type OwnSaleObservationSource = "external-channel" | "offline";

export type OwnSaleObservation = Readonly<{
  saleEventId: string;
  accountId: string;
  inventoryItemId: string;
  catalogItemId: string | null;
  productId: string | null;
  source: OwnSaleObservationSource;
  providerKey: string | null;
  offlineChannel: "in-store" | "card-show" | "other" | null;
  requestedQuantity: number | null;
  appliedQuantity: number;
  unitPriceAmount: string | null;
  currencyCode: string | null;
  shippingCollectedAmount: string | null;
  channelFeeAmount: string | null;
  soldAt: string | null;
  recordedAt: string;
  saleAt: string;
  updatedAt: string;
}>;

export type ListOwnSaleObservationsParams = Readonly<{
  accountId: string;
  catalogItemId?: string;
  productId?: string;
  since: string;
  sources?: readonly OwnSaleObservationSource[];
  providerKeys?: readonly string[];
}>;

type OwnSaleObservationRow = Readonly<{
  sale_event_id: string;
  seller_account_id: string;
  inventory_item_id: string;
  catalog_catalog_item_id: string | null;
  product_id: string | null;
  source: OwnSaleObservationSource;
  provider_key: string | null;
  offline_channel: "in-store" | "card-show" | "other" | null;
  requested_quantity: number | null;
  applied_quantity: number;
  unit_price_amount: string | null;
  currency_code: string | null;
  shipping_collected_amount: string | null;
  channel_fee_amount: string | null;
  sold_at: Date | null;
  recorded_at: Date;
  sale_at: Date;
  updated_at: Date;
}>;

export async function listOwnSaleObservations(
  db: PgQueryable,
  params: ListOwnSaleObservationsParams,
): Promise<readonly OwnSaleObservation[]> {
  const result = await db.query<OwnSaleObservationRow>(
    `SELECT observation.sale_event_id,
            observation.seller_account_id,
            observation.inventory_item_id,
            observation.catalog_catalog_item_id,
            observation.product_id,
            observation.source,
            observation.provider_key,
            observation.offline_channel,
            observation.requested_quantity,
            observation.applied_quantity,
            observation.unit_price_amount::text AS unit_price_amount,
            observation.currency_code,
            observation.shipping_collected_amount::text AS shipping_collected_amount,
            observation.channel_fee_amount::text AS channel_fee_amount,
            observation.sold_at,
            observation.recorded_at,
            observation.sale_at,
            observation.updated_at
     FROM pricing_own_sale_observations AS observation
     WHERE observation.seller_account_id = $1
       AND ($2::text IS NULL OR observation.catalog_catalog_item_id = $2)
       AND ($3::text IS NULL OR observation.product_id = $3)
       AND observation.sale_at >= $4
       AND ($5::text[] IS NULL OR observation.source = ANY($5::text[]))
       AND ($6::text[] IS NULL OR observation.provider_key = ANY($6::text[]))
     ORDER BY observation.sale_at, observation.sale_event_id`,
    [
      params.accountId,
      params.catalogItemId ?? null,
      params.productId ?? null,
      params.since,
      params.sources ? [...params.sources] : null,
      params.providerKeys ? [...params.providerKeys] : null,
    ],
  );

  return result.rows.map((row) => ({
    saleEventId: row.sale_event_id,
    accountId: row.seller_account_id,
    inventoryItemId: row.inventory_item_id,
    catalogItemId: row.catalog_catalog_item_id,
    productId: row.product_id,
    source: row.source,
    providerKey: row.provider_key,
    offlineChannel: row.offline_channel,
    requestedQuantity: row.requested_quantity,
    appliedQuantity: row.applied_quantity,
    unitPriceAmount: row.unit_price_amount,
    currencyCode: row.currency_code,
    shippingCollectedAmount: row.shipping_collected_amount,
    channelFeeAmount: row.channel_fee_amount,
    soldAt: row.sold_at ? new Date(row.sold_at).toISOString() : null,
    recordedAt: new Date(row.recorded_at).toISOString(),
    saleAt: new Date(row.sale_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

export type OwnSaleSellerCurrency = Readonly<{ accountId: string; currencyCode: string }>;

export type OwnSaleLow = Readonly<OwnSaleSellerCurrency & { unitPriceAmount: string | null }>;

export type GetOwnSaleLowsParams = Readonly<{
  catalogItemId: string;
  productId: string;
  since: string;
  sellers: readonly OwnSaleSellerCurrency[];
}>;

type OwnSaleLowRow = Readonly<{
  seller_account_id: string;
  currency_code: string;
  unit_price_amount: string | null;
}>;

export async function getOwnSaleLows(db: PgQueryable, params: GetOwnSaleLowsParams): Promise<readonly OwnSaleLow[]> {
  if (params.sellers.length === 0) return [];

  const result = await db.query<OwnSaleLowRow>(
    `WITH requested_sellers AS (
       SELECT requested.account_id, requested.currency_code, requested.ordinality
       FROM unnest($4::text[], $5::text[]) WITH ORDINALITY
         AS requested(account_id, currency_code, ordinality)
     )
     SELECT requested.account_id AS seller_account_id,
            requested.currency_code,
            MIN(observation.unit_price_amount)::text AS unit_price_amount
     FROM requested_sellers AS requested
     LEFT JOIN pricing_own_sale_observations AS observation
       ON observation.seller_account_id = requested.account_id
      AND observation.currency_code = requested.currency_code
      AND observation.catalog_catalog_item_id = $1
      AND observation.product_id = $2
      AND observation.sale_at >= $3
      AND observation.applied_quantity > 0
      AND observation.unit_price_amount IS NOT NULL
     GROUP BY requested.ordinality, requested.account_id, requested.currency_code
     ORDER BY requested.ordinality`,
    [
      params.catalogItemId,
      params.productId,
      params.since,
      params.sellers.map((seller) => seller.accountId),
      params.sellers.map((seller) => seller.currencyCode),
    ],
  );

  return result.rows.map((row) => ({
    accountId: row.seller_account_id,
    currencyCode: row.currency_code,
    unitPriceAmount: row.unit_price_amount,
  }));
}
