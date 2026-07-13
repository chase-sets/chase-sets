import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";

/**
 * Order Capacity enforcement (m127): plan-stage claims against the
 * seller's Open Order count, backed by `ordering_seller_open_order_claims`
 * (the truthful ledger, one row per Open Order) and
 * `ordering_seller_order_capacity_inputs` (the projected `max_open_orders`
 * fact from marketplace's Order Capacity setting).
 *
 * Every claim, release, and reconcile serializes through a single
 * `SELECT ... FOR UPDATE` on the seller's capacity-input row -- that row is
 * the lock, not a separate advisory lock -- so concurrent checkouts racing
 * the last slot for a seller are strictly ordered and the At Capacity
 * signal (`reconcileSellerOrderCapacity`, seller-capacity-signal.ts) only
 * ever observes one true crossing at a time.
 */

export type SellerOrderCapacityGroup = Readonly<{
  sellerAccountId: string;
  orderIds: readonly string[];
}>;

export type SellerOrderCapacityClaimResult = Readonly<{
  rejectedSellerAccountIds: readonly string[];
}>;

export type SellerOrderCapacityReconcileResult = Readonly<{
  atCapacity: boolean;
}>;

async function seedAndLockCapacityRow(
  client: Pick<PgQueryable, "query">,
  sellerAccountId: string,
): Promise<number | null> {
  await client.query(
    `INSERT INTO ordering_seller_order_capacity_inputs (seller_account_id, max_open_orders, updated_at)
     VALUES ($1, NULL, now())
     ON CONFLICT (seller_account_id) DO NOTHING`,
    [sellerAccountId],
  );
  const result = await client.query<{ max_open_orders: number | string | null }>(
    `SELECT max_open_orders
     FROM ordering_seller_order_capacity_inputs
     WHERE seller_account_id = $1
     FOR UPDATE`,
    [sellerAccountId],
  );
  const raw = result.rows[0]?.max_open_orders ?? null;
  return raw === null ? null : Number(raw);
}

async function countOpenClaims(client: Pick<PgQueryable, "query">, sellerAccountId: string): Promise<number> {
  const result = await client.query<{ open_count: number | string }>(
    `SELECT count(*)::integer AS open_count
     FROM ordering_seller_open_order_claims
     WHERE seller_account_id = $1
       AND status = 'claimed'`,
    [sellerAccountId],
  );
  return Number(result.rows[0]?.open_count ?? 0);
}

/**
 * Fast, non-locking pre-check: a seller who has never set a cap (or has
 * cleared it) has no row, or a row with `max_open_orders = NULL`. Both mean
 * "take no lock, zero overhead" per the m127 Order Capacity acceptance criteria.
 */
export async function loadSellerOrderCapacityCap(db: PgQueryable, sellerAccountId: string): Promise<number | null> {
  const result = await db.query<{ max_open_orders: number | string | null }>(
    `SELECT max_open_orders
     FROM ordering_seller_order_capacity_inputs
     WHERE seller_account_id = $1`,
    [sellerAccountId],
  );
  const raw = result.rows[0]?.max_open_orders ?? null;
  return raw === null ? null : Number(raw);
}

/**
 * Read-only seller-facing count of the account's currently Open Orders --
 * the authoritative "N" in the "N of M" Order Capacity display (m127). It
 * counts the Ordering-owned claim ledger (`ordering_seller_open_order_claims`,
 * status `'claimed'`), the same truth the plan-stage claim/release path
 * maintains, so the seller settings surface never counts orders client-side.
 * Non-locking: this is a display read, not a claim decision.
 */
export async function loadSellerOpenOrderCount(db: PgQueryable, sellerAccountId: string): Promise<number> {
  return countOpenClaims(db, sellerAccountId);
}

/**
 * Claims one Open Order slot per order id for each seller group in the
 * plan, transactionally (before CreateOrder is dispatched for any of
 * them). A seller whose group would push their open count over
 * `max_open_orders` is rejected as a group -- the other sellers' groups in
 * the same plan still claim and proceed, mirroring how per-seller plan
 * splitting already isolates failures elsewhere in ordering.
 *
 * `onClaimed` is called once per seller that successfully claims (outside
 * the claiming transaction, since it appends the At Capacity signal event
 * through the event store rather than raw SQL) so the signal can converge
 * immediately after a claim pushes a seller into capacity.
 */
export async function claimSellerOrderCapacity(
  db: PgTransactionalPool,
  groups: readonly SellerOrderCapacityGroup[],
  onClaimed?: (sellerAccountId: string) => Promise<void>,
): Promise<SellerOrderCapacityClaimResult> {
  const rejected: string[] = [];

  for (const group of groups) {
    if (group.orderIds.length === 0) {
      continue;
    }

    const cap = await loadSellerOrderCapacityCap(db, group.sellerAccountId);
    if (cap === null) {
      // Unlimited: still record the Open Order claim (untracked orders
      // would under-count if the seller sets a cap later while these are
      // still open), but skip the row lock and the threshold check
      // entirely -- zero lock overhead, no rejection possible.
      for (const orderId of group.orderIds) {
        await db.query(
          `INSERT INTO ordering_seller_open_order_claims (order_id, seller_account_id, status, claimed_at)
           VALUES ($1, $2, 'claimed', now())
           ON CONFLICT (order_id) DO NOTHING`,
          [orderId, group.sellerAccountId],
        );
      }
      continue;
    }

    const accepted = await withPgTransaction(db, async (client) => {
      const lockedCap = await seedAndLockCapacityRow(client, group.sellerAccountId);
      if (lockedCap === null) {
        // Cleared concurrently between the pre-check and the lock: allow.
        for (const orderId of group.orderIds) {
          await client.query(
            `INSERT INTO ordering_seller_open_order_claims (order_id, seller_account_id, status, claimed_at)
             VALUES ($1, $2, 'claimed', now())
             ON CONFLICT (order_id) DO NOTHING`,
            [orderId, group.sellerAccountId],
          );
        }
        return true;
      }

      const openCount = await countOpenClaims(client, group.sellerAccountId);
      if (openCount + group.orderIds.length > lockedCap) {
        return false;
      }

      for (const orderId of group.orderIds) {
        await client.query(
          `INSERT INTO ordering_seller_open_order_claims (order_id, seller_account_id, status, claimed_at)
           VALUES ($1, $2, 'claimed', now())
           ON CONFLICT (order_id) DO NOTHING`,
          [orderId, group.sellerAccountId],
        );
      }
      return true;
    });

    if (!accepted) {
      rejected.push(group.sellerAccountId);
      continue;
    }

    await onClaimed?.(group.sellerAccountId);
  }

  return { rejectedSellerAccountIds: rejected };
}

/**
 * Releases the Open Order claim for a single order, idempotently (a second
 * release for the same order id is a no-op -- the `status = 'claimed'`
 * guard prevents a double-release). Returns the seller account id when a
 * claim was actually released, so the caller can reconcile the At Capacity
 * signal only when something changed.
 */
export async function releaseSellerOrderCapacityClaim(
  db: PgQueryable,
  orderId: string,
  releasedAt: string,
): Promise<string | null> {
  const result = await db.query<{ seller_account_id: string }>(
    `UPDATE ordering_seller_open_order_claims
     SET status = 'released',
         released_at = $2
     WHERE order_id = $1
       AND status = 'claimed'
     RETURNING seller_account_id`,
    [orderId, releasedAt],
  );
  return result.rows[0]?.seller_account_id ?? null;
}

/**
 * Recomputes, under the seller's capacity row lock, whether the seller is
 * currently at capacity (a cap is set AND the open count has reached it).
 * Safe and cheap to call redundantly -- callers pair this with the
 * idempotent `MarkSellerAtCapacity` / `ClearSellerAtCapacity` decider, so
 * only the call that actually observes a state change produces a signal
 * event.
 */
export async function reconcileSellerOrderCapacity(
  db: PgTransactionalPool,
  sellerAccountId: string,
): Promise<SellerOrderCapacityReconcileResult> {
  return withPgTransaction(db, async (client) => {
    const cap = await seedAndLockCapacityRow(client, sellerAccountId);
    if (cap === null) {
      return { atCapacity: false };
    }
    const openCount = await countOpenClaims(client, sellerAccountId);
    return { atCapacity: openCount >= cap };
  });
}

/**
 * Deploy backfill (m127 item 6): seeds
 * `ordering_seller_open_order_claims` from every non-cancelled order whose
 * shipment (if any) has not yet dispatched, so Open Order counts start
 * truthful for sellers who already had orders in flight before this
 * enforcement slice shipped. `ON CONFLICT DO NOTHING` makes repeat runs a
 * no-op. Returns the distinct seller ids touched so the caller can
 * reconcile (and, where already over capacity, signal) each of them.
 */
export async function backfillSellerOpenOrderClaims(db: PgQueryable): Promise<readonly string[]> {
  const result = await db.query<{ seller_account_id: string }>(
    `INSERT INTO ordering_seller_open_order_claims (order_id, seller_account_id, status, claimed_at)
     SELECT page.order_id, page.seller_account_id, 'claimed', page.created_at
     FROM ordering_order_pages AS page
     LEFT JOIN ordering_fulfillment_cancellation_inputs AS fulfillment
       ON fulfillment.order_id = page.order_id
     WHERE page.status <> 'cancelled'
       AND (fulfillment.shipment_status IS NULL OR fulfillment.shipment_status <> 'dispatched')
     ON CONFLICT (order_id) DO NOTHING
     RETURNING seller_account_id`,
  );
  return [...new Set(result.rows.map((row) => row.seller_account_id))];
}
