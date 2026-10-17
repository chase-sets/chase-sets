import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { BuyerMarketPrice } from "../domain/evaluate";
import { evaluateBuyerOfferTarget, type BuyerOfferTargetInput } from "../domain/evaluate";

export function createBuyerOfferPricing(db: PgQueryable) {
  return {
    async evaluateTargets(requests: readonly Omit<BuyerOfferTargetInput, "marketPrice">[]) {
      const prices = await loadBuyerOfferMarketPrices(
        db,
        requests.map((request) => request.selection),
      );
      return requests.map((request, index) =>
        evaluateBuyerOfferTarget({ ...request, marketPrice: prices[index] ?? null }),
      );
    },
  };
}

export type BuyerOfferProductKey = Readonly<{ catalogItemId: string; productId: string }>;

/** One indexed, set-based read for the selected Products; absent rows stay null in input order. */
export async function loadBuyerOfferMarketPrices(
  db: PgQueryable,
  products: readonly BuyerOfferProductKey[],
): Promise<readonly (BuyerMarketPrice | null)[]> {
  if (products.length > 100) throw new Error("At most 100 buyer Offer Products may be loaded.");
  if (products.length === 0) return [];
  const result = await db.query<{
    catalog_item_id: string;
    product_id: string;
    estimate_version: string;
    amount: string;
    currency_code: string;
    estimated_at: Date;
    fresh_until: Date;
  }>(
    `SELECT estimate.catalog_catalog_item_id AS catalog_item_id, estimate.product_id,
            estimate.estimate_version::text AS estimate_version, estimate.amount::text AS amount,
            estimate.currency_code, estimate.estimated_at, estimate.fresh_until
       FROM (SELECT DISTINCT catalog_item_id, product_id
               FROM unnest($1::text[], $2::text[]) AS selected(catalog_item_id, product_id)) AS selected
       JOIN pricing_market_price_estimates AS estimate
         ON estimate.catalog_catalog_item_id = selected.catalog_item_id
        AND estimate.product_id = selected.product_id`,
    [products.map((product) => product.catalogItemId), products.map((product) => product.productId)],
  );
  const key = (product: BuyerOfferProductKey): string => JSON.stringify([product.catalogItemId, product.productId]);
  const byProduct = new Map<string, BuyerMarketPrice>();
  for (const row of result.rows) {
    byProduct.set(key({ catalogItemId: row.catalog_item_id, productId: row.product_id }), {
      catalogItemId: row.catalog_item_id,
      productId: row.product_id,
      estimateVersion: row.estimate_version,
      amount: row.amount,
      currencyCode: row.currency_code,
      estimatedAt: new Date(row.estimated_at).toISOString(),
      freshUntil: new Date(row.fresh_until).toISOString(),
    });
  }
  return products.map((product) => byProduct.get(key(product)) ?? null);
}
