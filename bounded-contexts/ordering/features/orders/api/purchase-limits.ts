import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import { OrderingDomainError, type OrderSourceType } from "../domain/common";
import type { MarketplaceSupplyCandidate } from "../domain/policies";
import { getOrderingSupplyCandidateByListingId } from "../integrations/supply/supply-queries";

type PurchaseLimitCheckoutPlan = Readonly<{
  orderDrafts: readonly Readonly<{
    sourceType: OrderSourceType;
    sourceReferenceId: string | null;
    lines: readonly Readonly<{ listingId: string; quantity: number }>[];
  }>[];
}>;

type ListingPurchaseLimitUsage = Readonly<{
  dayQuantity: number;
  customerAccountQuantity: number;
}>;

export const listingPurchaseLimitReachedReason = "Listing purchase limit reached for this customer account.";

function marketplaceDayStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function marketplaceDayKey(now = new Date()) {
  return marketplaceDayStart(now).slice(0, 10);
}

function finiteLimit(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function remainingForLimit(limit: number | null | undefined, used: number) {
  const normalized = finiteLimit(limit);
  return normalized === null ? Number.POSITIVE_INFINITY : Math.max(0, normalized - used);
}

function hasAccountScopedPurchaseLimit(candidate: MarketplaceSupplyCandidate) {
  return finiteLimit(candidate.maxUnitsPerDay) !== null || finiteLimit(candidate.maxUnitsPerCustomerAccount) !== null;
}

async function loadPurchaseLimitUsage(
  db: PgQueryable,
  buyerAccountId: string,
  listingId: string,
  sourceType: OrderSourceType = "cart-checkout",
  sourceReferenceId = "",
): Promise<ListingPurchaseLimitUsage> {
  const result = await db.query<{
    day_quantity: number | string | null;
    customer_account_quantity: number | string | null;
  }>(
    `WITH order_usage AS (
       SELECT
         COALESCE(SUM(line.quantity) FILTER (WHERE page.created_at >= $3::timestamptz), 0)::integer AS day_quantity,
         COALESCE(SUM(line.quantity), 0)::integer AS customer_account_quantity
       FROM ordering_order_pages AS page
       JOIN ordering_order_line_pages AS line ON line.order_id = page.order_id
       WHERE page.buyer_account_id = $1
         AND line.listing_id = $2
         AND page.status <> 'cancelled'
     ),
     active_claim_usage AS (
       SELECT
         COALESCE(SUM(claim.quantity) FILTER (WHERE claim.claimed_at >= $3::timestamptz), 0)::integer AS day_quantity,
         COALESCE(SUM(claim.quantity), 0)::integer AS customer_account_quantity
       FROM ordering_listing_purchase_limit_claims AS claim
       WHERE claim.buyer_account_id = $1
         AND claim.listing_id = $2
         AND claim.status = 'claimed'
         AND NOT (claim.source_type = $4 AND claim.source_reference_id = $5)
         AND NOT EXISTS (
           SELECT 1
           FROM ordering_order_pages AS page
           WHERE page.source_type = claim.source_type
             AND page.source_reference_id = claim.source_reference_id
             AND page.buyer_account_id = claim.buyer_account_id
             AND page.status <> 'cancelled'
         )
     )
     SELECT
       COALESCE(order_usage.day_quantity, 0) + COALESCE(active_claim_usage.day_quantity, 0) AS day_quantity,
       COALESCE(order_usage.customer_account_quantity, 0) + COALESCE(active_claim_usage.customer_account_quantity, 0) AS customer_account_quantity
     FROM order_usage, active_claim_usage`,
    [buyerAccountId, listingId, marketplaceDayStart(), sourceType, sourceReferenceId],
  );
  const row = result.rows[0];
  return {
    dayQuantity: Number(row?.day_quantity ?? 0),
    customerAccountQuantity: Number(row?.customer_account_quantity ?? 0),
  };
}

function allowedCandidateQuantity(candidate: MarketplaceSupplyCandidate, usage: ListingPurchaseLimitUsage) {
  const remaining = Math.min(
    candidate.availableQuantity,
    remainingForLimit(candidate.maxUnitsPerOrder, 0),
    remainingForLimit(candidate.maxUnitsPerDay, usage.dayQuantity),
    remainingForLimit(candidate.maxUnitsPerCustomerAccount, usage.customerAccountQuantity),
  );
  return Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : candidate.availableQuantity;
}

export async function applyPurchaseLimitAvailability(
  db: PgQueryable,
  buyerAccountId: string,
  candidates: readonly MarketplaceSupplyCandidate[],
  sourceType: OrderSourceType = "cart-checkout",
  sourceReferenceId = "",
) {
  const limited: MarketplaceSupplyCandidate[] = [];
  for (const candidate of candidates) {
    if (
      finiteLimit(candidate.maxUnitsPerOrder) === null &&
      finiteLimit(candidate.maxUnitsPerDay) === null &&
      finiteLimit(candidate.maxUnitsPerCustomerAccount) === null
    ) {
      limited.push(candidate);
      continue;
    }
    const usage = await loadPurchaseLimitUsage(db, buyerAccountId, candidate.listingId, sourceType, sourceReferenceId);
    limited.push({
      ...candidate,
      availableQuantity: allowedCandidateQuantity(candidate, usage),
    });
  }
  return limited;
}

export async function assertPlanPurchaseLimits(
  db: PgQueryable,
  buyerAccountId: string,
  plan: PurchaseLimitCheckoutPlan,
  sourceType: OrderSourceType,
  sourceReferenceId: string,
) {
  const quantities = new Map<string, number>();
  const limits = new Map<string, MarketplaceSupplyCandidate>();
  for (const draft of plan.orderDrafts) {
    for (const line of draft.lines) {
      quantities.set(line.listingId, (quantities.get(line.listingId) ?? 0) + line.quantity);
    }
  }

  for (const listingId of quantities.keys()) {
    const candidate = await getOrderingSupplyCandidateByListingId(db, listingId);
    if (candidate) {
      limits.set(listingId, candidate);
    }
  }

  for (const [listingId, quantity] of quantities.entries()) {
    const candidate = limits.get(listingId);
    if (!candidate) {
      continue;
    }
    const usage = await loadPurchaseLimitUsage(db, buyerAccountId, listingId, sourceType, sourceReferenceId);
    const allowed = allowedCandidateQuantity(candidate, usage);
    if (quantity > allowed) {
      throw new OrderingDomainError(listingPurchaseLimitReachedReason);
    }
  }
}

export async function planHasAccountScopedPurchaseLimits(db: PgQueryable, plan: PurchaseLimitCheckoutPlan) {
  const listingIds = new Set<string>();
  for (const draft of plan.orderDrafts) {
    for (const line of draft.lines) {
      listingIds.add(line.listingId);
    }
  }
  for (const listingId of listingIds) {
    const candidate = await getOrderingSupplyCandidateByListingId(db, listingId);
    if (candidate && hasAccountScopedPurchaseLimit(candidate)) {
      return true;
    }
  }
  return false;
}

export async function claimPlanPurchaseLimitUsage(
  db: PgQueryable,
  buyerAccountId: string,
  plan: PurchaseLimitCheckoutPlan,
) {
  const quantities = new Map<string, number>();
  let sourceType: OrderSourceType | null = null;
  let sourceReferenceId: string | null = null;

  for (const draft of plan.orderDrafts) {
    sourceType = draft.sourceType;
    sourceReferenceId = draft.sourceReferenceId;
    for (const line of draft.lines) {
      quantities.set(line.listingId, (quantities.get(line.listingId) ?? 0) + line.quantity);
    }
  }

  if (!sourceType || !sourceReferenceId) {
    return;
  }

  for (const [listingId, quantity] of quantities.entries()) {
    const candidate = await getOrderingSupplyCandidateByListingId(db, listingId);
    if (
      !candidate ||
      (finiteLimit(candidate.maxUnitsPerOrder) === null &&
        finiteLimit(candidate.maxUnitsPerDay) === null &&
        finiteLimit(candidate.maxUnitsPerCustomerAccount) === null)
    ) {
      continue;
    }

    const perOrderLimit = finiteLimit(candidate.maxUnitsPerOrder);
    if (perOrderLimit !== null && quantity > perOrderLimit) {
      throw new OrderingDomainError(listingPurchaseLimitReachedReason);
    }

    const insertedClaim = await db.query<{ claim_id: string }>(
      `INSERT INTO ordering_listing_purchase_limit_claims (
         claim_id,
         source_type,
         source_reference_id,
         buyer_account_id,
         listing_id,
         quantity,
         status,
         claimed_at,
         released_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', now(), NULL)
       ON CONFLICT (source_type, source_reference_id, buyer_account_id, listing_id)
       DO NOTHING
       RETURNING claim_id`,
      [createId("opl"), sourceType, sourceReferenceId, buyerAccountId, listingId, quantity],
    );

    if (insertedClaim.rowCount === 0) {
      const existingClaim = await db.query<{
        quantity: number | string;
        status: string;
      }>(
        `SELECT quantity, status
         FROM ordering_listing_purchase_limit_claims
         WHERE source_type = $1
           AND source_reference_id = $2
           AND buyer_account_id = $3
           AND listing_id = $4`,
        [sourceType, sourceReferenceId, buyerAccountId, listingId],
      );
      const existing = existingClaim.rows[0];
      if (existing?.status === "claimed" && Number(existing.quantity) === quantity) {
        continue;
      }
      throw new OrderingDomainError("Checkout confirmation for this listing is already in progress.");
    }

    const usage = await loadPurchaseLimitUsage(db, buyerAccountId, listingId, sourceType, sourceReferenceId);
    const dayKey = marketplaceDayKey();
    await db.query(
      `INSERT INTO ordering_listing_purchase_limit_usage (
         buyer_account_id,
         listing_id,
         marketplace_day,
         day_quantity,
         customer_account_quantity,
         updated_at
       )
       VALUES ($1, $2, $3::date, $4, $5, now())
       ON CONFLICT (buyer_account_id, listing_id) DO NOTHING`,
      [buyerAccountId, listingId, dayKey, usage.dayQuantity, usage.customerAccountQuantity],
    );
    await db.query(
      `UPDATE ordering_listing_purchase_limit_usage
       SET marketplace_day = $3::date,
           day_quantity = 0,
           updated_at = now()
       WHERE buyer_account_id = $1
         AND listing_id = $2
         AND marketplace_day <> $3::date`,
      [buyerAccountId, listingId, dayKey],
    );

    const claimed = await db.query<{ buyer_account_id: string }>(
      `UPDATE ordering_listing_purchase_limit_usage
       SET day_quantity = day_quantity + $4,
           customer_account_quantity = customer_account_quantity + $4,
           updated_at = now()
       WHERE buyer_account_id = $1
         AND listing_id = $2
         AND marketplace_day = $3::date
         AND ($5::integer IS NULL OR day_quantity + $4 <= $5)
         AND ($6::integer IS NULL OR customer_account_quantity + $4 <= $6)
       RETURNING buyer_account_id`,
      [
        buyerAccountId,
        listingId,
        dayKey,
        quantity,
        finiteLimit(candidate.maxUnitsPerDay),
        finiteLimit(candidate.maxUnitsPerCustomerAccount),
      ],
    );

    if (claimed.rowCount === 0) {
      await db.query(
        `UPDATE ordering_listing_purchase_limit_claims
         SET status = 'released',
             released_at = now()
         WHERE source_type = $1
           AND source_reference_id = $2
           AND buyer_account_id = $3
           AND listing_id = $4
           AND status = 'pending'`,
        [sourceType, sourceReferenceId, buyerAccountId, listingId],
      );
      throw new OrderingDomainError(listingPurchaseLimitReachedReason);
    }

    await db.query(
      `UPDATE ordering_listing_purchase_limit_claims
       SET status = 'claimed',
           released_at = NULL
       WHERE source_type = $1
         AND source_reference_id = $2
         AND buyer_account_id = $3
         AND listing_id = $4
         AND status = 'pending'`,
      [sourceType, sourceReferenceId, buyerAccountId, listingId],
    );
  }
}

export async function releasePurchaseLimitClaimsForOrder(
  db: PgQueryable,
  order: Readonly<{
    source_type: string;
    source_reference_id: string | null;
    buyer_account_id: string;
    lines: readonly Readonly<{ listing_id: string }>[];
  }>,
) {
  if (!order.source_reference_id) {
    return;
  }
  const listingIds = [...new Set(order.lines.map((line) => line.listing_id))];
  if (listingIds.length === 0) {
    return;
  }
  const releasedClaims = await db.query<{
    listing_id: string;
    quantity: number | string;
    claimed_at: string;
  }>(
    `UPDATE ordering_listing_purchase_limit_claims
     SET status = 'released',
         released_at = now()
     WHERE source_type = $1
       AND source_reference_id = $2
       AND buyer_account_id = $3
       AND listing_id = ANY($4::text[])
       AND status = 'claimed'
     RETURNING listing_id, quantity, claimed_at`,
    [order.source_type, order.source_reference_id, order.buyer_account_id, listingIds],
  );

  for (const claim of releasedClaims.rows) {
    await db.query(
      `UPDATE ordering_listing_purchase_limit_usage
       SET day_quantity = CASE
             WHEN marketplace_day = $3::date THEN GREATEST(0, day_quantity - $4)
             ELSE day_quantity
           END,
           customer_account_quantity = GREATEST(0, customer_account_quantity - $4),
           updated_at = now()
       WHERE buyer_account_id = $1
         AND listing_id = $2`,
      [order.buyer_account_id, claim.listing_id, String(claim.claimed_at).slice(0, 10), Number(claim.quantity)],
    );
  }
}
