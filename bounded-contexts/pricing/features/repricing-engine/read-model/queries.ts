import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { RepricingRule } from "../../repricing-policies/domain/domain";

export type RepricingRoundListing = Readonly<{
  listingId: string;
  sellerAccountId: string;
  inventoryItemId: string | null;
  catalogItemId: string;
  productId: string;
  priceAmount: string;
  quantityCap: number;
  listingVersion: number;
  categoryIds: readonly string[];
  costBasisAmount: string | null;
  policyId: string;
  policyRevision: string;
  rules: readonly RepricingRule[];
  maxChangesPerDay: number;
}>;

export type RepricingRoundInputs = Readonly<{
  listings: readonly RepricingRoundListing[];
  competingAsks: readonly Readonly<{
    listingId: string;
    sellerAccountId: string;
    amount: string;
    pricingMode: "hard" | "derived";
  }>[];
  marketEstimate: Readonly<{ amount: string; freshUntil: string }> | null;
  lastSoldAmount: string | null;
}>;

type ListingRow = Readonly<{
  listing_id: string;
  seller_account_id: string;
  inventory_item_id: string | null;
  catalog_catalog_item_id: string;
  product_id: string;
  price_amount: string;
  quantity_cap: number;
  last_stream_version: number;
  category_ids: readonly string[] | null;
  acquisition_cost_amount: string | null;
  policy_id: string;
  policy_revision: string;
  rules: readonly RepricingRule[] | string;
  max_changes_per_day: number;
}>;

export async function loadRepricingRoundInputs(
  db: PgQueryable,
  product: Readonly<{ catalogItemId: string; productId: string }>,
): Promise<RepricingRoundInputs> {
  const [listingResult, askResult, estimateResult, lastSoldResult] = await Promise.all([
    db.query<ListingRow>(
      `SELECT
         listing.listing_id,
         listing.seller_account_id,
         listing.inventory_item_id,
         listing.catalog_catalog_item_id,
         listing.product_id,
         listing.price_amount::text,
         listing.quantity_cap,
         listing.last_stream_version,
         catalog.category_ids,
         inventory.acquisition_cost_amount::text,
         assignment.policy_id,
         policy.updated_at::text AS policy_revision,
         policy.rules,
         policy.max_changes_per_day
       FROM pricing_repricing_policy_assignments AS assignment
       JOIN pricing_market_listing_inputs AS listing
         ON listing.listing_id = assignment.listing_id
       JOIN pricing_repricing_policies AS policy
         ON policy.policy_id = assignment.policy_id
       LEFT JOIN pricing_catalog_item_inputs AS catalog
         ON catalog.catalog_item_id = listing.catalog_catalog_item_id
       LEFT JOIN pricing_inventory_item_inputs AS inventory
         ON inventory.item_id = listing.inventory_item_id
        AND inventory.seller_account_id = listing.seller_account_id
       WHERE listing.catalog_catalog_item_id = $1
         AND listing.product_id = $2
         AND listing.status IN ('active', 'draft')
       ORDER BY assignment.policy_id, listing.listing_id`,
      [product.catalogItemId, product.productId],
    ),
    db.query<{
      listing_id: string;
      seller_account_id: string;
      amount: string;
      pricing_mode: "hard" | "derived";
    }>(
      `SELECT
         listing.listing_id,
         listing.seller_account_id,
         listing.price_amount::text AS amount,
         CASE WHEN assignment.listing_id IS NULL THEN 'hard' ELSE 'derived' END AS pricing_mode
       FROM pricing_market_listing_inputs AS listing
       LEFT JOIN pricing_repricing_policy_assignments AS assignment
         ON assignment.listing_id = listing.listing_id
       WHERE listing.catalog_catalog_item_id = $1
         AND listing.product_id = $2
         AND listing.status = 'active'
       ORDER BY listing.listing_id`,
      [product.catalogItemId, product.productId],
    ),
    db.query<{ amount: string; fresh_until: string }>(
      `SELECT amount::text, fresh_until::text
       FROM pricing_market_price_estimates
       WHERE catalog_catalog_item_id = $1
         AND product_id = $2`,
      [product.catalogItemId, product.productId],
    ),
    db.query<{ unit_price_amount: string }>(
      `SELECT unit_price_amount::text
       FROM pricing_market_trades
       WHERE catalog_catalog_item_id = $1
         AND product_id = $2
         AND sold_at IS NOT NULL
         AND excluded = false
       ORDER BY sold_at DESC, order_id DESC, line_id DESC
       LIMIT 1`,
      [product.catalogItemId, product.productId],
    ),
  ]);

  return {
    listings: listingResult.rows.map((row) => ({
      listingId: row.listing_id,
      sellerAccountId: row.seller_account_id,
      inventoryItemId: row.inventory_item_id,
      catalogItemId: row.catalog_catalog_item_id,
      productId: row.product_id,
      priceAmount: row.price_amount,
      quantityCap: row.quantity_cap,
      listingVersion: Number(row.last_stream_version),
      categoryIds: row.category_ids ?? [],
      costBasisAmount: row.acquisition_cost_amount,
      policyId: row.policy_id,
      policyRevision: row.policy_revision,
      rules: typeof row.rules === "string" ? (JSON.parse(row.rules) as readonly RepricingRule[]) : row.rules,
      maxChangesPerDay: row.max_changes_per_day,
    })),
    competingAsks: askResult.rows.map((row) => ({
      listingId: row.listing_id,
      sellerAccountId: row.seller_account_id,
      amount: row.amount,
      pricingMode: row.pricing_mode,
    })),
    marketEstimate: estimateResult.rows[0]
      ? { amount: estimateResult.rows[0].amount, freshUntil: estimateResult.rows[0].fresh_until }
      : null,
    lastSoldAmount: lastSoldResult.rows[0]?.unit_price_amount ?? null,
  };
}

export async function getRepricingProductForListing(
  db: PgQueryable,
  listingId: string,
): Promise<Readonly<{ catalogItemId: string; productId: string }> | null> {
  const result = await db.query<{ catalog_catalog_item_id: string; product_id: string }>(
    `SELECT catalog_catalog_item_id, product_id
     FROM pricing_market_listing_inputs
     WHERE listing_id = $1`,
    [listingId],
  );
  const row = result.rows[0];
  return row ? { catalogItemId: row.catalog_catalog_item_id, productId: row.product_id } : null;
}

export async function listAssignedRepricingProducts(
  db: PgQueryable,
  params: Readonly<{
    after: Readonly<{ catalogItemId: string; productId: string }> | null;
    limit: number;
  }>,
): Promise<readonly Readonly<{ catalogItemId: string; productId: string }>[]> {
  const result = await db.query<{ catalog_catalog_item_id: string; product_id: string }>(
    `SELECT DISTINCT listing.catalog_catalog_item_id, listing.product_id
     FROM pricing_repricing_policy_assignments AS assignment
     JOIN pricing_market_listing_inputs AS listing
       ON listing.listing_id = assignment.listing_id
     WHERE listing.status IN ('active', 'draft')
       AND ($1::text IS NULL OR (listing.catalog_catalog_item_id, listing.product_id) > ($1, $2))
     ORDER BY listing.catalog_catalog_item_id, listing.product_id
     LIMIT $3`,
    [params.after?.catalogItemId ?? null, params.after?.productId ?? null, params.limit],
  );
  return result.rows.map((row) => ({
    catalogItemId: row.catalog_catalog_item_id,
    productId: row.product_id,
  }));
}

export async function hasEvaluationStream(db: PgQueryable, streamId: string): Promise<boolean> {
  const result = await db.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM event_store_streams WHERE stream_id = $1) AS present`,
    [streamId],
  );
  return result.rows[0]?.present ?? false;
}
