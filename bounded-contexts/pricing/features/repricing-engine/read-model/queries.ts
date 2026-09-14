import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CreateRepricingPolicyCommand, RepricingRule } from "../../repricing-policies/domain/domain";
import { candidateAssignmentSql } from "../../repricing-policies/read-model/schema";

export type RepricingRoundListing = Readonly<{
  listingId: string;
  sellerAccountId: string;
  inventoryItemId: string | null;
  catalogItemId: string;
  productId: string;
  priceAmount: string;
  priceCurrencyCode: string | null;
  quantityCap: number;
  listingVersion: number;
  listingStatus: "active" | "paused";
  pauseReason: string | null;
  categoryIds: readonly string[];
  grading: "graded" | "raw" | null;
  createdAt: string | null;
  costBasisAmount: string | null;
  costBasisCurrencyCode: string | null;
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
    currencyCode: string | null;
    pricingMode: "hard" | "derived";
  }>[];
  marketEstimate: Readonly<{ amount: string; currencyCode: string; freshUntil: string }> | null;
  lastSold: Readonly<{ amount: string; currencyCode: string | null; soldAt: string }> | null;
}>;

type ListingRow = Readonly<{
  listing_id: string;
  seller_account_id: string;
  inventory_item_id: string | null;
  catalog_catalog_item_id: string;
  product_id: string;
  price_amount: string;
  price_currency_code: string | null;
  quantity_cap: number;
  last_stream_version: number;
  status: "active" | "paused";
  pause_reason: string | null;
  grading: "graded" | "raw" | null;
  created_at: string | null;
  category_ids: readonly string[] | null;
  acquisition_cost_amount: string | null;
  acquisition_cost_currency_code: string | null;
  policy_id: string;
  policy_revision: string;
  rules: readonly RepricingRule[] | string;
  max_changes_per_day: number;
}>;

export type RepricingProductKey = Readonly<{ catalogItemId: string; productId: string }>;
export type RepricingCandidate = Readonly<{
  sellerAccountId: string;
  body: Pick<CreateRepricingPolicyCommand, "scope" | "excludedListingIds" | "rules" | "maxChangesPerDay">;
  replacingPolicyId?: string;
}>;

export const repricingProductKey = (product: RepricingProductKey): string =>
  JSON.stringify([product.catalogItemId, product.productId]);

export const repricingCandidateCte = `candidate AS (
  SELECT $3::jsonb->>'sellerAccountId' AS seller_account_id,
    $3::jsonb->>'replacingPolicyId' AS replacing_policy_id,
    $3::jsonb->'body'->'scope'->>'kind' AS scope_kind,
    ARRAY(SELECT jsonb_array_elements_text($3::jsonb->'body'->'scope'->'categoryIds')) AS scope_category_ids,
    ARRAY(SELECT jsonb_array_elements_text($3::jsonb->'body'->'scope'->'listingIds')) AS scope_listing_ids,
    ARRAY(SELECT jsonb_array_elements_text($3::jsonb->'body'->'excludedListingIds')) AS excluded_listing_ids,
    $3::jsonb->'body'->'rules' AS rules,
    ($3::jsonb->'body'->>'maxChangesPerDay')::integer AS max_changes_per_day
)`;

const productKeysCte = `products AS (
  SELECT * FROM unnest($1::text[], $2::text[]) AS keys(catalog_catalog_item_id, product_id)
)`;
const eligibleListingSql = `(listing.status = 'active'
  OR (listing.status = 'paused' AND listing.pause_reason = 'policy-input-missing'))`;

type ProductRow = { catalog_catalog_item_id: string; product_id: string };

export async function loadRepricingRoundInputs(
  db: PgQueryable,
  product: RepricingProductKey,
  candidate?: RepricingCandidate,
): Promise<RepricingRoundInputs> {
  return (await loadRepricingRoundInputsPage(db, { products: [product], candidate })).get(
    repricingProductKey(product),
  )!;
}

export async function loadRepricingRoundInputsPage(
  db: PgQueryable,
  input: Readonly<{ products: readonly RepricingProductKey[]; candidate?: RepricingCandidate }>,
): Promise<Map<string, RepricingRoundInputs>> {
  if (input.products.length > 500) throw new Error("Repricing pages cannot exceed 500 products.");
  const products = [...new Map(input.products.map((product) => [repricingProductKey(product), product])).values()];
  const rounds = new Map<
    string,
    {
      listings: RepricingRoundListing[];
      competingAsks: Array<RepricingRoundInputs["competingAsks"][number]>;
      marketEstimate: RepricingRoundInputs["marketEstimate"];
      lastSold: RepricingRoundInputs["lastSold"];
    }
  >();
  for (const product of products) {
    rounds.set(repricingProductKey(product), { listings: [], competingAsks: [], marketEstimate: null, lastSold: null });
  }
  if (!products.length) return rounds;
  const keys = [products.map((key) => key.catalogItemId), products.map((key) => key.productId)];
  const [listings, asks, estimates, sales] = await Promise.all([
    db.query<ListingRow>(
      `WITH ${productKeysCte}, ${repricingCandidateCte}
       SELECT listing.listing_id, listing.seller_account_id, listing.inventory_item_id,
         listing.catalog_catalog_item_id, listing.product_id, listing.price_amount::text,
         listing.price_currency_code, listing.quantity_cap, listing.last_stream_version,
         listing.status, listing.pause_reason, listing.grading, listing.created_at::text,
         catalog_item.category_ids, inventory.acquisition_cost_amount::text,
         inventory.acquisition_cost_currency_code,
         CASE WHEN candidate.seller_account_id IS NULL THEN assignment.policy_id
           ELSE COALESCE(candidate.replacing_policy_id, 'repricing-candidate') END AS policy_id,
         CASE WHEN candidate.seller_account_id IS NULL THEN policy.updated_at::text
           ELSE statement_timestamp()::text END AS policy_revision,
         COALESCE(candidate.rules, policy.rules) AS rules,
         COALESCE(candidate.max_changes_per_day, policy.max_changes_per_day) AS max_changes_per_day
       FROM products
       JOIN pricing_market_listing_inputs AS listing USING (catalog_catalog_item_id, product_id)
       CROSS JOIN candidate
       LEFT JOIN pricing_catalog_item_inputs AS catalog_item
         ON catalog_item.catalog_item_id = listing.catalog_catalog_item_id
       LEFT JOIN pricing_inventory_item_inputs AS inventory
         ON inventory.item_id = listing.inventory_item_id AND inventory.seller_account_id = listing.seller_account_id
       LEFT JOIN pricing_repricing_policy_assignments AS assignment
         ON candidate.seller_account_id IS NULL AND assignment.listing_id = listing.listing_id
       LEFT JOIN pricing_repricing_policies AS policy ON policy.policy_id = assignment.policy_id
       WHERE ${eligibleListingSql}
         AND ((candidate.seller_account_id IS NULL AND policy.status = 'active')
           OR (${candidateAssignmentSql}))
       ORDER BY policy_id, listing.listing_id`,
      [...keys, input.candidate ? JSON.stringify(input.candidate) : null],
    ),
    db.query<
      ProductRow & {
        listing_id: string;
        seller_account_id: string;
        amount: string;
        price_currency_code: string | null;
        pricing_mode: "hard" | "derived";
      }
    >(
      `WITH ${productKeysCte}
       SELECT listing.catalog_catalog_item_id, listing.product_id, listing.listing_id,
         listing.seller_account_id, listing.price_amount::text AS amount, listing.price_currency_code,
         CASE WHEN assignment.listing_id IS NULL THEN 'hard' ELSE 'derived' END AS pricing_mode
       FROM products
       JOIN pricing_market_listing_inputs AS listing USING (catalog_catalog_item_id, product_id)
       LEFT JOIN pricing_repricing_policy_assignments AS assignment ON assignment.listing_id = listing.listing_id
       WHERE listing.status = 'active' ORDER BY listing.listing_id`,
      keys,
    ),
    db.query<ProductRow & { amount: string; currency_code: string; fresh_until: string }>(
      `WITH ${productKeysCte}
       SELECT estimate.catalog_catalog_item_id, estimate.product_id, estimate.amount::text,
         UPPER(estimate.currency_code) AS currency_code, estimate.fresh_until::text
       FROM products JOIN pricing_market_price_estimates AS estimate USING (catalog_catalog_item_id, product_id)`,
      keys,
    ),
    db.query<ProductRow & { unit_price_amount: string; currency_code: string | null; sold_at: string }>(
      `WITH ${productKeysCte}
       SELECT DISTINCT ON (trade.catalog_catalog_item_id, trade.product_id)
         trade.catalog_catalog_item_id, trade.product_id, trade.unit_price_amount::text,
         NULL::text AS currency_code, trade.sold_at::text
       FROM products JOIN pricing_market_trades AS trade USING (catalog_catalog_item_id, product_id)
       WHERE trade.sold_at IS NOT NULL AND trade.excluded = false
       ORDER BY trade.catalog_catalog_item_id, trade.product_id, trade.sold_at DESC, trade.order_id DESC, trade.line_id DESC`,
      keys,
    ),
  ]);
  const partition = (row: ProductRow) =>
    rounds.get(
      repricingProductKey({
        catalogItemId: row.catalog_catalog_item_id,
        productId: row.product_id,
      }),
    )!;
  for (const row of listings.rows)
    partition(row).listings.push({
      listingId: row.listing_id,
      sellerAccountId: row.seller_account_id,
      inventoryItemId: row.inventory_item_id,
      catalogItemId: row.catalog_catalog_item_id,
      productId: row.product_id,
      priceAmount: row.price_amount,
      priceCurrencyCode: row.price_currency_code,
      quantityCap: row.quantity_cap,
      listingVersion: Number(row.last_stream_version),
      listingStatus: row.status,
      pauseReason: row.pause_reason,
      categoryIds: row.category_ids ?? [],
      grading: row.grading,
      createdAt: row.created_at,
      costBasisAmount: row.acquisition_cost_amount,
      costBasisCurrencyCode: row.acquisition_cost_currency_code,
      policyId: row.policy_id,
      policyRevision: row.policy_revision,
      rules: typeof row.rules === "string" ? JSON.parse(row.rules) : row.rules,
      maxChangesPerDay: row.max_changes_per_day,
    });
  for (const row of asks.rows)
    partition(row).competingAsks.push({
      listingId: row.listing_id,
      sellerAccountId: row.seller_account_id,
      amount: row.amount,
      currencyCode: row.price_currency_code,
      pricingMode: row.pricing_mode,
    });
  for (const row of estimates.rows)
    partition(row).marketEstimate = {
      amount: row.amount,
      currencyCode: row.currency_code,
      freshUntil: row.fresh_until,
    };
  for (const row of sales.rows)
    partition(row).lastSold = {
      amount: row.unit_price_amount,
      currencyCode: row.currency_code,
      soldAt: row.sold_at,
    };
  return rounds;
}

export async function listCandidateRepricingProducts(
  db: PgQueryable,
  candidate: RepricingCandidate,
  after: RepricingProductKey | null,
): Promise<readonly RepricingProductKey[]> {
  const result = await db.query<ProductRow>(
    `WITH ${repricingCandidateCte}
     SELECT DISTINCT listing.catalog_catalog_item_id, listing.product_id
     FROM pricing_market_listing_inputs AS listing
     CROSS JOIN candidate
     LEFT JOIN pricing_catalog_item_inputs AS catalog_item ON catalog_item.catalog_item_id = listing.catalog_catalog_item_id
     WHERE ${eligibleListingSql} AND (${candidateAssignmentSql})
       AND ($1::text IS NULL OR (listing.catalog_catalog_item_id, listing.product_id) > ($1::text, $2::text))
     ORDER BY listing.catalog_catalog_item_id, listing.product_id LIMIT 500`,
    [after?.catalogItemId ?? null, after?.productId ?? null, JSON.stringify(candidate)],
  );
  return result.rows.map((row) => ({ catalogItemId: row.catalog_catalog_item_id, productId: row.product_id }));
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
     JOIN pricing_repricing_policies AS policy
       ON policy.policy_id = assignment.policy_id
     WHERE (listing.status = 'active' OR (listing.status = 'paused' AND listing.pause_reason = 'policy-input-missing'))
       AND policy.status = 'active'
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

export async function isRepricingPolicyRevisionActive(
  db: PgQueryable,
  input: Readonly<{ policyId: string; policyRevision: string }>,
): Promise<boolean> {
  const result = await db.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pricing_repricing_policies
       WHERE policy_id = $1
         AND status = 'active'
         AND updated_at::text = $2
         AND NOT EXISTS (
           SELECT 1 FROM pricing_repricing_halts AS halt
           WHERE halt.seller_account_id = pricing_repricing_policies.seller_account_id AND halt.engaged
         )
     ) AS active`,
    [input.policyId, input.policyRevision],
  );
  return result.rows[0]?.active ?? false;
}

export async function hasEvaluationStream(db: PgQueryable, streamId: string): Promise<boolean> {
  const result = await db.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM event_store_streams WHERE stream_id = $1) AS present`,
    [streamId],
  );
  return result.rows[0]?.present ?? false;
}
