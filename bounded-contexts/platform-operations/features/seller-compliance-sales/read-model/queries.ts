import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CaptureAnomaly, ReconciliationMismatch, RefundAnomaly, SaleState } from "./projection";

/**
 * Bounded reads over the recorded seller sale facts.
 *
 * Every read is a page with a hard limit, a full keyset cursor, an explicit termination
 * signal, and a fixed pass snapshot. These are stateless query cursors, not checkpoint
 * authority: the later cohort evaluator (#7146) must own its own durable per-trigger sweep
 * checkpoint, because a cursor that lives only in a caller's loop cannot survive a restart
 * or a scheduled-runner tick boundary.
 */

export const MIN_PAGE_LIMIT = 1;
export const MAX_PAGE_LIMIT = 100;

/**
 * One half-open UTC contract for every read and for the #7146 expiry handoff:
 * `value >= fromInclusive AND value < toExclusive`. At millisecond precision
 * `fromInclusive - 1 ms` is out, `fromInclusive` is in, `toExclusive - 1 ms` is in, and
 * `toExclusive` is out.
 */
export type HalfOpenUtcWindow = Readonly<{
  fromInclusive: string;
  toExclusive: string;
}>;

export function isWithinHalfOpenWindow(value: string, window: HalfOpenUtcWindow): boolean {
  const at = Date.parse(value);
  return at >= Date.parse(window.fromInclusive) && at < Date.parse(window.toExclusive);
}

/** Calendar-month arithmetic clamped to the target month's last day (31 Jan + 1 month = 28/29 Feb). */
export function addUtcMonths(instant: string, months: number): string {
  const anchor = new Date(instant);
  const anchorDay = anchor.getUTCDate();
  const targetYear = anchor.getUTCFullYear();
  const targetMonth = anchor.getUTCMonth() + months;
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(anchorDay, lastDayOfTargetMonth),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  ).toISOString();
}

/**
 * The approved inclusive lookback floor: an anchor at the floor is still eligible at exactly
 * its nominal lookback instant and expires at that instant plus exactly 1 ms. This is the
 * same half-open convention read from the other side, not a competing formula.
 */
export function isLookbackAnchorEligible(anchorAt: string, lookbackMonths: number, evaluationAt: string): boolean {
  return Date.parse(evaluationAt) <= Date.parse(addUtcMonths(anchorAt, lookbackMonths));
}

function assertPageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < MIN_PAGE_LIMIT || limit > MAX_PAGE_LIMIT) {
    throw new Error(
      `Seller compliance sale page limit must be an integer between ${MIN_PAGE_LIMIT} and ${MAX_PAGE_LIMIT}.`,
    );
  }
  return limit;
}

/**
 * A page whose returned cursor equals the one it was given has not advanced, so a caller
 * looping on it would claim progress forever. Every page function enforces this itself
 * rather than trusting the loop.
 */
export function isCursorAdvanced(previous: unknown, next: unknown): boolean {
  return next === null || JSON.stringify(previous ?? null) !== JSON.stringify(next);
}

function assertCursorAdvanced(previous: unknown, next: unknown): void {
  if (!isCursorAdvanced(previous, next)) {
    throw new Error(
      "Seller compliance sale page returned a non-advancing cursor; the enumeration would not terminate.",
    );
  }
}

export type SellerPage = Readonly<{
  sellerAccountIds: readonly string[];
  nextCursor: string | null;
}>;

export type SellerEnumerationInput = HalfOpenUtcWindow &
  Readonly<{
    /**
     * The pass snapshot, fixed at pass start. A newly completed row, or an existing
     * completed row materially changed after pass start, receives a higher
     * `change_sequence` and joins the next pass rather than being silently missed.
     */
    snapshotChangeSequence: string;
    afterSellerAccountId?: string | null;
    limit: number;
  }>;

/**
 * The maximum completed-row change sequence, read once to fix a pass. `"0"` when no
 * completed sale exists yet.
 */
export async function readSellerComplianceSnapshotChangeSequence(db: PgQueryable): Promise<string> {
  const result = await db.query<{ snapshot: string | null }>(
    `SELECT MAX(change_sequence)::text AS snapshot
     FROM platform_operations_seller_compliance_sales
     WHERE recorded_at IS NOT NULL`,
  );
  return result.rows[0]?.snapshot ?? "0";
}

async function listSellers(db: PgQueryable, column: "changed_at" | "occurred_at", input: SellerEnumerationInput) {
  const limit = assertPageLimit(input.limit);
  const afterSellerAccountId = input.afterSellerAccountId ?? null;
  const result = await db.query<{ seller_account_id: string }>(
    `SELECT DISTINCT seller_account_id
     FROM platform_operations_seller_compliance_sales
     WHERE recorded_at IS NOT NULL
       AND seller_account_id IS NOT NULL
       AND change_sequence <= $1::bigint
       AND ${column} >= $2 AND ${column} < $3
       AND ($4::text IS NULL OR seller_account_id > $4::text)
     ORDER BY seller_account_id ASC
     LIMIT $5`,
    [input.snapshotChangeSequence, input.fromInclusive, input.toExclusive, afterSellerAccountId, limit],
  );
  const sellerAccountIds = result.rows.map((row) => row.seller_account_id);
  const nextCursor = sellerAccountIds.length < limit ? null : (sellerAccountIds[sellerAccountIds.length - 1] ?? null);
  assertCursorAdvanced(afterSellerAccountId, nextCursor);
  return { sellerAccountIds, nextCursor } satisfies SellerPage;
}

/**
 * Recording-time family: sellers whose completed sale rows changed inside the window.
 * Deliberately distinct from the occurrence-time family below -- a sale captured long ago
 * whose refund arrives today changes today but occurred then, so the two families answer
 * different questions and are not interchangeable.
 */
export function listSellersWithChangedCompletedSales(
  db: PgQueryable,
  input: SellerEnumerationInput,
): Promise<SellerPage> {
  return listSellers(db, "changed_at", input);
}

/** Occurrence-time family: sellers whose completed sales occurred inside the window. */
export function listSellersWithSalesOccurringInWindow(
  db: PgQueryable,
  input: SellerEnumerationInput,
): Promise<SellerPage> {
  return listSellers(db, "occurred_at", input);
}

export type SellerSaleCursor = Readonly<{
  occurredAt: string;
  paymentId: string;
  orderId: string;
}>;

export type SellerSaleFact = Readonly<{
  paymentId: string;
  orderId: string;
  sellerAccountId: string;
  saleState: SaleState;
  occurredAt: string;
  currencyCode: string | null;
  itemGrossCents: string | null;
  shippingChargeCents: string | null;
  salesTaxCents: string | null;
  authenticityFeeCents: string | null;
  protectionCents: string | null;
  orderTotalCents: string | null;
  marketplaceSalesFeeCents: string | null;
  sellerItemNetCents: string | null;
  sellerPayoutCents: string | null;
  refundedOrderTotalCents: string | null;
  orderRefundCapCents: string | null;
  cancelledAt: string | null;
  captureAnomalies: readonly CaptureAnomaly[];
  refundAnomalies: readonly RefundAnomaly[];
  reconciliationMismatches: readonly ReconciliationMismatch[];
  classificationInputs: unknown;
  classificationInputsVersion: number;
  changeSequence: string;
  revision: string;
}>;

export type SellerSalePage = Readonly<{
  sales: readonly SellerSaleFact[];
  nextCursor: SellerSaleCursor | null;
}>;

export type SellerSalePageInput = HalfOpenUtcWindow &
  Readonly<{
    sellerAccountId: string;
    cursor?: SellerSaleCursor | null;
    limit: number;
  }>;

type SellerSaleRow = Readonly<{
  payment_id: string;
  order_id: string;
  seller_account_id: string;
  sale_state: SaleState;
  occurred_at: Date;
  currency_code: string | null;
  item_gross_cents: string | null;
  shipping_charge_cents: string | null;
  sales_tax_cents: string | null;
  authenticity_fee_cents: string | null;
  protection_cents: string | null;
  order_total_cents: string | null;
  marketplace_sales_fee_cents: string | null;
  seller_item_net_cents: string | null;
  seller_payout_cents: string | null;
  refunded_order_total_cents: string | null;
  order_refund_cap_cents: string | null;
  cancelled_at: Date | null;
  capture_anomalies: readonly CaptureAnomaly[];
  refund_anomalies: readonly RefundAnomaly[];
  reconciliation_mismatches: readonly ReconciliationMismatch[];
  classification_inputs: unknown;
  classification_inputs_version: number;
  change_sequence: string;
  revision: string;
}>;

/**
 * One seller's completed sales in `(occurred_at, payment_id, order_id)` keyset order. The
 * cursor is the full tuple, so equal occurrence instants still page deterministically and a
 * restart from a returned cursor reproduces the exact suffix.
 */
export async function listSellerCompletedSalesPage(
  db: PgQueryable,
  input: SellerSalePageInput,
): Promise<SellerSalePage> {
  const limit = assertPageLimit(input.limit);
  const cursor = input.cursor ?? null;
  const result = await db.query<SellerSaleRow>(
    `SELECT payment_id, order_id, seller_account_id, sale_state, occurred_at, currency_code,
            item_gross_cents::text, shipping_charge_cents::text, sales_tax_cents::text,
            authenticity_fee_cents::text, protection_cents::text, order_total_cents::text,
            marketplace_sales_fee_cents::text, seller_item_net_cents::text, seller_payout_cents::text,
            refunded_order_total_cents::text, order_refund_cap_cents::text, cancelled_at,
            capture_anomalies, refund_anomalies, reconciliation_mismatches,
            classification_inputs, classification_inputs_version,
            change_sequence::text, revision::text
     FROM platform_operations_seller_compliance_sales
     WHERE seller_account_id = $1
       AND recorded_at IS NOT NULL
       AND occurred_at >= $2 AND occurred_at < $3
       AND ($4::timestamptz IS NULL OR (occurred_at, payment_id, order_id) > ($4::timestamptz, $5::text, $6::text))
     ORDER BY occurred_at ASC, payment_id ASC, order_id ASC
     LIMIT $7`,
    [
      input.sellerAccountId,
      input.fromInclusive,
      input.toExclusive,
      cursor?.occurredAt ?? null,
      cursor?.paymentId ?? null,
      cursor?.orderId ?? null,
      limit,
    ],
  );

  const sales = result.rows.map(
    (row): SellerSaleFact => ({
      paymentId: row.payment_id,
      orderId: row.order_id,
      sellerAccountId: row.seller_account_id,
      saleState: row.sale_state,
      occurredAt: row.occurred_at.toISOString(),
      currencyCode: row.currency_code,
      itemGrossCents: row.item_gross_cents,
      shippingChargeCents: row.shipping_charge_cents,
      salesTaxCents: row.sales_tax_cents,
      authenticityFeeCents: row.authenticity_fee_cents,
      protectionCents: row.protection_cents,
      orderTotalCents: row.order_total_cents,
      marketplaceSalesFeeCents: row.marketplace_sales_fee_cents,
      sellerItemNetCents: row.seller_item_net_cents,
      sellerPayoutCents: row.seller_payout_cents,
      refundedOrderTotalCents: row.refunded_order_total_cents,
      orderRefundCapCents: row.order_refund_cap_cents,
      cancelledAt: row.cancelled_at === null ? null : row.cancelled_at.toISOString(),
      captureAnomalies: row.capture_anomalies,
      refundAnomalies: row.refund_anomalies,
      reconciliationMismatches: row.reconciliation_mismatches,
      classificationInputs: row.classification_inputs,
      classificationInputsVersion: row.classification_inputs_version,
      changeSequence: row.change_sequence,
      revision: row.revision,
    }),
  );

  const last = sales[sales.length - 1];
  const nextCursor =
    sales.length < limit || last === undefined
      ? null
      : { occurredAt: last.occurredAt, paymentId: last.paymentId, orderId: last.orderId };
  assertCursorAdvanced(cursor, nextCursor);
  return { sales, nextCursor };
}

export type SellerSalesSnapshotToken = Readonly<{
  rowCount: number;
  revisionSum: string;
}>;

/**
 * The scalar token a paged consumer reads before its first page and again after its last.
 * A concurrent material change moves `revision_sum` (and a new row moves `row_count`), so a
 * mismatch tells the consumer to discard the partial evaluation and restart from null
 * rather than acting on a torn scan.
 */
export async function readSellerCompletedSalesSnapshotToken(
  db: PgQueryable,
  input: HalfOpenUtcWindow & Readonly<{ sellerAccountId: string }>,
): Promise<SellerSalesSnapshotToken> {
  const result = await db.query<{ row_count: string; revision_sum: string }>(
    `SELECT COUNT(*)::text AS row_count, COALESCE(SUM(revision), 0)::text AS revision_sum
     FROM platform_operations_seller_compliance_sales
     WHERE seller_account_id = $1
       AND recorded_at IS NOT NULL
       AND occurred_at >= $2 AND occurred_at < $3`,
    [input.sellerAccountId, input.fromInclusive, input.toExclusive],
  );
  return {
    rowCount: Number(result.rows[0]?.row_count ?? "0"),
    revisionSum: result.rows[0]?.revision_sum ?? "0",
  };
}

export function snapshotTokensMatch(left: SellerSalesSnapshotToken, right: SellerSalesSnapshotToken): boolean {
  return left.rowCount === right.rowCount && left.revisionSum === right.revisionSum;
}
