import { resolveProjectionDb, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { isCanonicalMoneyAmount, moneyToCents } from "@chase-sets/primitives/money";

/**
 * Records neutral, replayable facts about platform-processed seller sales.
 *
 * Ordering owns the seller, the order money decomposition, and the classification inputs;
 * Payments owns capture, payout, and refund. Neither is re-derived here and no other
 * context's table is read. This projection evaluates no threshold, publishes no event, and
 * reaches no legal or policy conclusion; the later cohort evaluator consumes these facts
 * separately.
 *
 * Two relations exist because an Ordering event carries no payment identity: order facts
 * are retained by `order_id` until a Payments event supplies `payment_id`, at which point
 * the same transaction materializes or refreshes the `(payment_id, order_id)` sale row.
 * Whichever side arrives second converges on the identical row.
 */

export const CAPTURE_ANOMALY_ORDER = [
  "duplicate-capture-order-id",
  "extra-payout-component",
  "duplicate-payout-component",
  "missing-payout-component",
  "seller-mismatch",
  "currency-invalid",
  "canonical-money-invalid",
  "source-field-missing",
] as const;

export const REFUND_ANOMALY_ORDER = [
  "duplicate-refund-order-id",
  "refund-order-membership-invalid",
  "duplicate-refunded-amount-entry",
  "missing-refunded-amount-entry",
  "duplicate-refund-cap-entry",
  "missing-refund-cap-entry",
  "currency-invalid",
  "canonical-money-invalid",
  "source-field-missing",
] as const;

/**
 * Cross-source arithmetic disagreements. These are deliberately a separate, closed
 * vocabulary rather than extra members of the capture anomaly law: the eight capture
 * reasons classify membership, currency, money form, and field presence, while these
 * classify two well-formed sources that do not agree. A row carrying either is
 * `captured-unreconciled` with every money column null, so neither can fail open.
 */
export const RECONCILIATION_MISMATCH_ORDER = [
  "item-gross-vs-payout-split",
  "shipping-allowance-representation",
  "protection-representation",
  "protection-allowance-representation",
  "protection-overage-representation",
] as const;

export type CaptureAnomaly = (typeof CAPTURE_ANOMALY_ORDER)[number];
export type RefundAnomaly = (typeof REFUND_ANOMALY_ORDER)[number];
export type ReconciliationMismatch = (typeof RECONCILIATION_MISMATCH_ORDER)[number];

export type SaleState = "awaiting-capture" | "awaiting-order" | "captured" | "captured-unreconciled";
export type OrderFactLifecycleState = "awaiting-capture" | "cancelled-awaiting-capture";

/** The only currency vocabulary this projection admits today. */
const ADMITTED_CURRENCY_CODE = "usd";

export const CAPTURE_PAYOUT_MONEY_FIELDS = [
  "marketplaceSalesFeeAmount",
  "sellerItemNetAmount",
  "shippingAllowanceAmount",
  "sellerShippingPayoutAmount",
  "protectionAmount",
  "protectionAllowanceAmount",
  "protectionOverageAmount",
  "sellerPayoutAmount",
] as const;

export const ORDER_MONEY_FIELDS = [
  "itemSubtotalAmount",
  "shippingChargeAmount",
  "shippingAllowanceAmount",
  "salesTaxAmount",
  "authenticityFeeAmount",
  "protectionAmount",
  "protectionAllowanceAmount",
  "protectionOverageAmount",
  "orderTotalAmount",
] as const;

export type CapturePayoutFact = Readonly<Record<string, unknown>>;

export type CaptureFact = Readonly<{
  paymentId: unknown;
  orderIds: unknown;
  sellerPayouts: unknown;
  currencyCode: unknown;
  capturedAt: unknown;
}>;

export type RefundFact = Readonly<{
  paymentId: unknown;
  orderIds: unknown;
  refundedOrderAmounts: unknown;
  orderRefundCaps: unknown;
  currencyCode: unknown;
  refundedAt: unknown;
}>;

export type OrderMoneyFact = Readonly<Record<(typeof ORDER_MONEY_FIELDS)[number], string | null>>;

export type ClassificationInput = Readonly<{
  lineId: string;
  catalogItemId: string;
  productId: string;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  quantity: number;
  lineTotalAmount: string;
  gradedCard: Readonly<{ gradingCompany: string; grade: string }> | null;
}>;

export const CLASSIFICATION_INPUTS_VERSION = 1;

function sortedUnique<TValue extends string>(values: Iterable<TValue>, order: readonly TValue[]): TValue[] {
  const present = new Set(values);
  return order.filter((value) => present.has(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The admission predicate. `tryMoneyToCents` is deliberately not used: it trims and accepts
 * one-decimal input, so it would admit values the recorded fact must reject. Unknown or
 * rejected money stays null and is never inferred as zero.
 */
export function canonicalCents(value: unknown): bigint | null {
  return typeof value === "string" && isCanonicalMoneyAmount(value) ? moneyToCents(value) : null;
}

export function isAdmittedCurrency(value: unknown): boolean {
  return value === ADMITTED_CURRENCY_CODE;
}

function countByOrderId(entries: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const orderId = isRecord(entry) ? entry.orderId : undefined;
    if (!isNonEmptyString(orderId)) continue;
    counts.set(orderId, (counts.get(orderId) ?? 0) + 1);
  }
  return counts;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function distinctOrderIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(isNonEmptyString))] : [];
}

/**
 * The capture-atomic reasons: everything the capture event alone determines. A capture-wide
 * defect applies to every row in that capture, so payout input order cannot change the
 * result and no per-row refund rule can weaken it. `seller-mismatch` and the order-side
 * money reasons are added later by `deriveCaptureAnomalies`, once Ordering's authoritative
 * facts exist.
 */
export function classifyCaptureAtomicAnomalies(capture: CaptureFact): CaptureAnomaly[] {
  const anomalies = new Set<CaptureAnomaly>();
  const orderIds = Array.isArray(capture.orderIds) ? capture.orderIds : null;
  const payouts = Array.isArray(capture.sellerPayouts) ? capture.sellerPayouts : null;

  if (!isNonEmptyString(capture.paymentId) || !isNonEmptyString(capture.capturedAt)) {
    anomalies.add("source-field-missing");
  }
  if (!orderIds || orderIds.length === 0 || !orderIds.every(isNonEmptyString)) {
    anomalies.add("source-field-missing");
  }
  if (!payouts) {
    anomalies.add("source-field-missing");
  }
  if (!isNonEmptyString(capture.currencyCode)) {
    anomalies.add("source-field-missing");
  } else if (!isAdmittedCurrency(capture.currencyCode)) {
    anomalies.add("currency-invalid");
  }

  const declaredOrderIds = orderIds?.filter(isNonEmptyString) ?? [];
  const distinct = new Set(declaredOrderIds);
  if (declaredOrderIds.length !== distinct.size) {
    anomalies.add("duplicate-capture-order-id");
  }

  const payoutCounts = countByOrderId(payouts ?? []);
  for (const [orderId, count] of payoutCounts) {
    if (!distinct.has(orderId)) {
      anomalies.add("extra-payout-component");
    } else if (count > 1) {
      anomalies.add("duplicate-payout-component");
    }
  }
  for (const orderId of distinct) {
    if ((payoutCounts.get(orderId) ?? 0) === 0) {
      anomalies.add("missing-payout-component");
    }
  }

  for (const payout of payouts ?? []) {
    if (!isRecord(payout) || !isNonEmptyString(payout.orderId) || !isNonEmptyString(payout.sellerAccountId)) {
      anomalies.add("source-field-missing");
      continue;
    }
    for (const field of CAPTURE_PAYOUT_MONEY_FIELDS) {
      const amount = payout[field];
      if (amount === undefined || amount === null || typeof amount !== "string" || amount.length === 0) {
        anomalies.add("source-field-missing");
      } else if (!isCanonicalMoneyAmount(amount)) {
        anomalies.add("canonical-money-invalid");
      }
    }
  }

  return sortedUnique(anomalies, CAPTURE_ANOMALY_ORDER);
}

export function selectCapturePayout(capture: CaptureFact, orderId: string): CapturePayoutFact | null {
  const payouts = Array.isArray(capture.sellerPayouts) ? capture.sellerPayouts : [];
  const matching = payouts.filter((payout) => isRecord(payout) && payout.orderId === orderId);
  // A duplicate payout component is already a capture anomaly; retaining the sole
  // component only when exactly one exists keeps "the sole payout component" literal.
  return matching.length === 1 && isRecord(matching[0]) ? (matching[0] as CapturePayoutFact) : null;
}

export type AffectedRefundFact = Readonly<{
  anomalies: RefundAnomaly[];
  refundedOrderTotalCents: bigint | null;
  orderRefundCapCents: bigint | null;
}>;

/**
 * Selects one affected order's refund facts from a payment-scoped event.
 *
 * Payments emits payment-wide `orderRefundCaps` and `refundedOrderAmounts` (cumulative
 * across every order previously refunded on the payment) alongside affected-scoped
 * `orderIds`. Entries for payment orders outside the affected set are expected producer
 * output: they are ignored, create or update no unaffected row, raise no anomaly, and can
 * never cure a defect in an affected entry. Totals and caps are assigned, never accumulated,
 * so redelivery, shuffled entry order, and empty-schema replay all converge.
 *
 * `captureMembership` is null while no capture has been observed for the payment, in which
 * case membership is not yet knowable and is not asserted.
 */
export function selectAffectedRefundFact(
  refund: RefundFact,
  orderId: string,
  captureMembership: readonly string[] | null,
): AffectedRefundFact {
  const anomalies = new Set<RefundAnomaly>();
  const affected = Array.isArray(refund.orderIds) ? refund.orderIds : null;

  if (!isNonEmptyString(refund.paymentId) || !isNonEmptyString(refund.refundedAt)) {
    anomalies.add("source-field-missing");
  }
  if (!affected || affected.length === 0 || !affected.every(isNonEmptyString)) {
    anomalies.add("source-field-missing");
  }
  if (!Array.isArray(refund.refundedOrderAmounts) || !Array.isArray(refund.orderRefundCaps)) {
    anomalies.add("source-field-missing");
  }
  if (!isNonEmptyString(refund.currencyCode)) {
    anomalies.add("source-field-missing");
  } else if (!isAdmittedCurrency(refund.currencyCode)) {
    anomalies.add("currency-invalid");
  }

  const declaredAffected = affected?.filter(isNonEmptyString) ?? [];
  if (declaredAffected.length !== new Set(declaredAffected).size) {
    anomalies.add("duplicate-refund-order-id");
  }
  if (captureMembership !== null && !captureMembership.includes(orderId)) {
    anomalies.add("refund-order-membership-invalid");
  }

  const amountEntries = (Array.isArray(refund.refundedOrderAmounts) ? refund.refundedOrderAmounts : []).filter(
    (entry) => isRecord(entry) && entry.orderId === orderId,
  );
  const capEntries = (Array.isArray(refund.orderRefundCaps) ? refund.orderRefundCaps : []).filter(
    (entry) => isRecord(entry) && entry.orderId === orderId,
  );

  if (amountEntries.length > 1) anomalies.add("duplicate-refunded-amount-entry");
  if (amountEntries.length === 0) anomalies.add("missing-refunded-amount-entry");
  if (capEntries.length > 1) anomalies.add("duplicate-refund-cap-entry");
  if (capEntries.length === 0) anomalies.add("missing-refund-cap-entry");

  const amountCents =
    amountEntries.length === 1 ? canonicalCents((amountEntries[0] as CapturePayoutFact).amount) : null;
  const capCents = capEntries.length === 1 ? canonicalCents((capEntries[0] as CapturePayoutFact).amount) : null;
  if (amountEntries.length === 1 && amountCents === null) anomalies.add("canonical-money-invalid");
  if (capEntries.length === 1 && capCents === null) anomalies.add("canonical-money-invalid");

  const sorted = sortedUnique(anomalies, REFUND_ANOMALY_ORDER);
  return sorted.length > 0
    ? { anomalies: sorted, refundedOrderTotalCents: null, orderRefundCapCents: null }
    : { anomalies: sorted, refundedOrderTotalCents: amountCents, orderRefundCapCents: capCents };
}

export type AdmittedSaleMoney = Readonly<{
  itemGrossCents: bigint;
  shippingChargeCents: bigint;
  salesTaxCents: bigint;
  authenticityFeeCents: bigint;
  protectionCents: bigint;
  protectionAllowanceCents: bigint;
  protectionOverageCents: bigint;
  orderTotalCents: bigint;
  marketplaceSalesFeeCents: bigint;
  sellerItemNetCents: bigint;
  shippingAllowanceCents: bigint;
  sellerShippingPayoutCents: bigint;
  sellerPayoutCents: bigint;
}>;

export type SaleMoneyAdmission = Readonly<{
  orderSideAnomalies: CaptureAnomaly[];
  mismatches: ReconciliationMismatch[];
  money: AdmittedSaleMoney | null;
}>;

/**
 * Atomic money admission. Every required order-side and payout-side string must be present
 * and canonical, currency must be exactly `usd`, and every cross-source check must agree.
 * Nothing is derived by subtraction and no absent value becomes zero.
 */
export function admitSaleMoney(
  order: OrderMoneyFact | null,
  payout: CapturePayoutFact | null,
  currencyCode: unknown,
): SaleMoneyAdmission {
  const orderSideAnomalies = new Set<CaptureAnomaly>();
  if (order === null || payout === null) {
    return { orderSideAnomalies: [], mismatches: [], money: null };
  }

  const orderCents = new Map<string, bigint>();
  for (const field of ORDER_MONEY_FIELDS) {
    const raw = order[field];
    if (raw === null) {
      orderSideAnomalies.add("source-field-missing");
      continue;
    }
    const cents = canonicalCents(raw);
    if (cents === null) {
      orderSideAnomalies.add("canonical-money-invalid");
      continue;
    }
    orderCents.set(field, cents);
  }

  const payoutCents = new Map<string, bigint>();
  for (const field of CAPTURE_PAYOUT_MONEY_FIELDS) {
    const cents = canonicalCents(payout[field]);
    if (cents !== null) payoutCents.set(field, cents);
  }

  const sortedOrderSide = sortedUnique(orderSideAnomalies, CAPTURE_ANOMALY_ORDER);
  const complete =
    sortedOrderSide.length === 0 &&
    orderCents.size === ORDER_MONEY_FIELDS.length &&
    payoutCents.size === CAPTURE_PAYOUT_MONEY_FIELDS.length &&
    isAdmittedCurrency(currencyCode);
  if (!complete) {
    return { orderSideAnomalies: sortedOrderSide, mismatches: [], money: null };
  }

  const itemGrossCents = orderCents.get("itemSubtotalAmount")!;
  const marketplaceSalesFeeCents = payoutCents.get("marketplaceSalesFeeAmount")!;
  const sellerItemNetCents = payoutCents.get("sellerItemNetAmount")!;
  const mismatches = new Set<ReconciliationMismatch>();
  if (itemGrossCents !== sellerItemNetCents + marketplaceSalesFeeCents) {
    mismatches.add("item-gross-vs-payout-split");
  }
  if (orderCents.get("shippingAllowanceAmount") !== payoutCents.get("shippingAllowanceAmount")) {
    mismatches.add("shipping-allowance-representation");
  }
  if (orderCents.get("protectionAmount") !== payoutCents.get("protectionAmount")) {
    mismatches.add("protection-representation");
  }
  if (orderCents.get("protectionAllowanceAmount") !== payoutCents.get("protectionAllowanceAmount")) {
    mismatches.add("protection-allowance-representation");
  }
  if (orderCents.get("protectionOverageAmount") !== payoutCents.get("protectionOverageAmount")) {
    mismatches.add("protection-overage-representation");
  }

  const sortedMismatches = sortedUnique(mismatches, RECONCILIATION_MISMATCH_ORDER);
  if (sortedMismatches.length > 0) {
    return { orderSideAnomalies: sortedOrderSide, mismatches: sortedMismatches, money: null };
  }

  return {
    orderSideAnomalies: sortedOrderSide,
    mismatches: sortedMismatches,
    money: {
      itemGrossCents,
      shippingChargeCents: orderCents.get("shippingChargeAmount")!,
      salesTaxCents: orderCents.get("salesTaxAmount")!,
      authenticityFeeCents: orderCents.get("authenticityFeeAmount")!,
      protectionCents: orderCents.get("protectionAmount")!,
      protectionAllowanceCents: orderCents.get("protectionAllowanceAmount")!,
      protectionOverageCents: orderCents.get("protectionOverageAmount")!,
      orderTotalCents: orderCents.get("orderTotalAmount")!,
      marketplaceSalesFeeCents,
      sellerItemNetCents,
      shippingAllowanceCents: payoutCents.get("shippingAllowanceAmount")!,
      sellerShippingPayoutCents: payoutCents.get("sellerShippingPayoutAmount")!,
      sellerPayoutCents: payoutCents.get("sellerPayoutAmount")!,
    },
  };
}

/**
 * The complete eight-member capture law for one row: the retained capture-atomic reasons,
 * plus the reasons that only become knowable once Ordering's authoritative seller and order
 * money exist. Recomputed on every write so either arrival order converges.
 */
export function deriveCaptureAnomalies(
  atomic: readonly CaptureAnomaly[],
  authoritativeSellerAccountId: string | null,
  payoutSellerAccountId: string | null,
  orderSideAnomalies: readonly CaptureAnomaly[],
): CaptureAnomaly[] {
  const anomalies = new Set<CaptureAnomaly>([...atomic, ...orderSideAnomalies]);
  if (
    authoritativeSellerAccountId !== null &&
    payoutSellerAccountId !== null &&
    authoritativeSellerAccountId !== payoutSellerAccountId
  ) {
    anomalies.add("seller-mismatch");
  }
  return sortedUnique(anomalies, CAPTURE_ANOMALY_ORDER);
}

/**
 * One classification input per line, versioned. It records the approved policy input fields
 * from their source and nothing more: no product form, no title-derived condition, no
 * certification number, and no later classification conclusion.
 */
export function extractClassificationInputs(lines: unknown): ClassificationInput[] {
  if (!Array.isArray(lines)) return [];
  return lines.filter(isRecord).map((line) => {
    const gradedCard = isRecord(line.gradedCard) ? line.gradedCard : null;
    return {
      lineId: String(line.lineId ?? ""),
      catalogItemId: String(line.catalogItemId ?? ""),
      productId: String(line.productId ?? ""),
      selectedOptions: (Array.isArray(line.selectedOptions) ? line.selectedOptions : [])
        .filter(isRecord)
        .map((option) => ({ dimensionId: String(option.dimensionId ?? ""), optionId: String(option.optionId ?? "") })),
      quantity: typeof line.quantity === "number" ? line.quantity : 0,
      lineTotalAmount: String(line.lineTotalAmount ?? ""),
      gradedCard: gradedCard
        ? { gradingCompany: String(gradedCard.gradingCompany ?? ""), grade: String(gradedCard.grade ?? "") }
        : null,
    };
  });
}

type OrderFactRow = Readonly<{
  order_id: string;
  seller_account_id: string | null;
  item_subtotal_amount: string | null;
  shipping_charge_amount: string | null;
  shipping_allowance_amount: string | null;
  sales_tax_amount: string | null;
  authenticity_fee_amount: string | null;
  protection_amount: string | null;
  protection_allowance_amount: string | null;
  protection_overage_amount: string | null;
  order_total_amount: string | null;
  classification_inputs: unknown;
  classification_inputs_version: number;
  order_created_source_version: string | null;
  order_cancelled_source_version: string | null;
  cancelled_at: Date | null;
  lifecycle_state: OrderFactLifecycleState;
  revision: string;
}>;

type SaleRow = Readonly<{
  payment_id: string;
  order_id: string;
  seller_account_id: string | null;
  sale_state: SaleState;
  occurred_at: Date | null;
  currency_code: string | null;
  capture_payout_seller_account_id: string | null;
  capture_marketplace_sales_fee_amount: string | null;
  capture_seller_item_net_amount: string | null;
  capture_shipping_allowance_amount: string | null;
  capture_seller_shipping_payout_amount: string | null;
  capture_protection_amount: string | null;
  capture_protection_allowance_amount: string | null;
  capture_protection_overage_amount: string | null;
  capture_seller_payout_amount: string | null;
  refunded_order_total_cents: string | null;
  order_refund_cap_cents: string | null;
  refund_observed_at: Date | null;
  capture_atomic_anomalies: unknown;
  refund_anomalies: unknown;
  payment_captured_source_version: string | null;
  payment_refunded_source_version: string | null;
  revision: string;
  recorded_at: Date | null;
}>;

/** The capture-side source facts a sale row retains so either arrival order can complete it. */
type RetainedCaptureFacts = Readonly<{
  occurredAt: string | null;
  currencyCode: string | null;
  payoutSellerAccountId: string | null;
  payout: CapturePayoutFact | null;
  atomicAnomalies: readonly CaptureAnomaly[];
  capturedSourceVersion: number | null;
}>;

type RetainedRefundFacts = Readonly<{
  refundedOrderTotalCents: bigint | null;
  orderRefundCapCents: bigint | null;
  refundObservedAt: string | null;
  anomalies: readonly RefundAnomaly[];
  refundedSourceVersion: number | null;
}>;

function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toBigIntOrNull(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function toNumberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * Each source field group compares only its own retained stream version, which is what lets
 * a refund observed before its capture keep the later, lower-versioned capture group
 * writable. An absent version means the group has never been observed, so the event applies.
 */
function isStaleGroupVersion(storedVersion: string | null, observedVersion: number): boolean {
  const stored = toNumberOrNull(storedVersion);
  return stored !== null && stored >= observedVersion;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function payoutFromRow(row: SaleRow): CapturePayoutFact | null {
  if (row.capture_payout_seller_account_id === null) return null;
  return {
    orderId: row.order_id,
    sellerAccountId: row.capture_payout_seller_account_id,
    marketplaceSalesFeeAmount: row.capture_marketplace_sales_fee_amount,
    sellerItemNetAmount: row.capture_seller_item_net_amount,
    shippingAllowanceAmount: row.capture_shipping_allowance_amount,
    sellerShippingPayoutAmount: row.capture_seller_shipping_payout_amount,
    protectionAmount: row.capture_protection_amount,
    protectionAllowanceAmount: row.capture_protection_allowance_amount,
    protectionOverageAmount: row.capture_protection_overage_amount,
    sellerPayoutAmount: row.capture_seller_payout_amount,
  };
}

function orderMoneyFromRow(row: OrderFactRow | null): OrderMoneyFact | null {
  if (row === null || row.order_created_source_version === null) return null;
  return {
    itemSubtotalAmount: row.item_subtotal_amount,
    shippingChargeAmount: row.shipping_charge_amount,
    shippingAllowanceAmount: row.shipping_allowance_amount,
    salesTaxAmount: row.sales_tax_amount,
    authenticityFeeAmount: row.authenticity_fee_amount,
    protectionAmount: row.protection_amount,
    protectionAllowanceAmount: row.protection_allowance_amount,
    protectionOverageAmount: row.protection_overage_amount,
    orderTotalAmount: row.order_total_amount,
  };
}

/**
 * Serializes every writer touching one order across both subscriptions.
 *
 * Row locks alone are not enough here: the Ordering and Payments subscriptions run in
 * separate transactions, and a capture that finds no order-fact row locks nothing, so a
 * concurrently inserted order fact could be missed and leave the sale stuck in
 * `awaiting-order`. A transaction-scoped advisory lock on the order id exists whether or
 * not the row does, which is what makes both arrival orders converge under interleaving.
 */
async function lockOrderScope(db: PgQueryable, orderId: string): Promise<void> {
  await db.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('platform-operations:seller-compliance-sales:order:' || $1::text, 0))`,
    [orderId],
  );
}

async function lockOrderFact(db: PgQueryable, orderId: string): Promise<OrderFactRow | null> {
  const result = await db.query<OrderFactRow>(
    `SELECT * FROM platform_operations_seller_compliance_order_facts WHERE order_id = $1 FOR UPDATE`,
    [orderId],
  );
  return result.rows[0] ?? null;
}

async function lockSaleRow(db: PgQueryable, paymentId: string, orderId: string): Promise<SaleRow | null> {
  const result = await db.query<SaleRow>(
    `SELECT * FROM platform_operations_seller_compliance_sales
     WHERE payment_id = $1 AND order_id = $2
     FOR UPDATE`,
    [paymentId, orderId],
  );
  return result.rows[0] ?? null;
}

/**
 * The capture membership known for a payment: the orders whose sale rows already carry a
 * capture. Null while no capture has been observed, because membership is not yet knowable
 * and a refund arriving first must not be judged against an absent authority.
 */
async function readCaptureMembership(db: PgQueryable, paymentId: string): Promise<string[] | null> {
  const result = await db.query<{ order_id: string }>(
    `SELECT order_id FROM platform_operations_seller_compliance_sales
     WHERE payment_id = $1 AND payment_captured_source_version IS NOT NULL
     ORDER BY order_id ASC`,
    [paymentId],
  );
  return result.rows.length === 0 ? null : result.rows.map((row) => row.order_id);
}

type MaterializedSale = Readonly<{
  sellerAccountId: string | null;
  saleState: SaleState;
  occurredAt: string | null;
  currencyCode: string | null;
  capture: RetainedCaptureFacts;
  refund: RetainedRefundFacts;
  captureAnomalies: readonly CaptureAnomaly[];
  mismatches: readonly ReconciliationMismatch[];
  money: AdmittedSaleMoney | null;
  classificationInputs: readonly ClassificationInput[];
  classificationInputsVersion: number;
  cancelledAt: string | null;
  orderCreatedSourceVersion: number | null;
  orderCancelledSourceVersion: number | null;
}>;

function materializeSale(
  orderFact: OrderFactRow | null,
  capture: RetainedCaptureFacts,
  refund: RetainedRefundFacts,
): MaterializedSale {
  const hasOrder = orderFact !== null && orderFact.order_created_source_version !== null;
  const hasCapture = capture.capturedSourceVersion !== null;
  const orderMoney = orderMoneyFromRow(orderFact);
  const admission = hasCapture && hasOrder ? admitSaleMoney(orderMoney, capture.payout, capture.currencyCode) : null;
  const captureAnomalies = hasCapture
    ? deriveCaptureAnomalies(
        capture.atomicAnomalies,
        hasOrder ? (orderFact?.seller_account_id ?? null) : null,
        capture.payoutSellerAccountId,
        admission?.orderSideAnomalies ?? [],
      )
    : [];
  const mismatches = admission?.mismatches ?? [];
  const reconciled = hasCapture && hasOrder && captureAnomalies.length === 0 && mismatches.length === 0;
  const money = reconciled ? (admission?.money ?? null) : null;

  const saleState: SaleState = !hasCapture
    ? "awaiting-capture"
    : !hasOrder
      ? "awaiting-order"
      : money !== null
        ? "captured"
        : "captured-unreconciled";

  return {
    sellerAccountId: hasOrder ? (orderFact?.seller_account_id ?? null) : null,
    saleState,
    occurredAt: capture.occurredAt,
    currencyCode: capture.currencyCode,
    capture,
    refund,
    captureAnomalies,
    mismatches,
    money,
    classificationInputs: hasOrder ? (orderFact?.classification_inputs as ClassificationInput[]) : [],
    classificationInputsVersion: hasOrder ? (orderFact?.classification_inputs_version ?? 1) : 1,
    cancelledAt: hasOrder ? toIsoOrNull(orderFact?.cancelled_at ?? null) : null,
    orderCreatedSourceVersion: hasOrder ? toNumberOrNull(orderFact?.order_created_source_version ?? null) : null,
    orderCancelledSourceVersion: hasOrder ? toNumberOrNull(orderFact?.order_cancelled_source_version ?? null) : null,
  };
}

function isCompletedState(state: SaleState): boolean {
  return state === "captured" || state === "captured-unreconciled";
}

/**
 * The material columns, in the order the write binds them. Comparing the computed tuple
 * against the stored one is what keeps duplicate delivery and steady-state replay inert:
 * `change_sequence` and `changed_at` advance only when a retained or derived fact moves.
 */
function materialTuple(sale: MaterializedSale): unknown[] {
  return [
    sale.sellerAccountId,
    sale.saleState,
    sale.occurredAt,
    sale.currencyCode,
    sale.capture.payoutSellerAccountId,
    ...CAPTURE_PAYOUT_MONEY_FIELDS.map((field) => (sale.capture.payout?.[field] as string | null | undefined) ?? null),
    sale.money?.itemGrossCents ?? null,
    sale.money?.shippingChargeCents ?? null,
    sale.money?.salesTaxCents ?? null,
    sale.money?.authenticityFeeCents ?? null,
    sale.money?.protectionCents ?? null,
    sale.money?.protectionAllowanceCents ?? null,
    sale.money?.protectionOverageCents ?? null,
    sale.money?.orderTotalCents ?? null,
    sale.money?.marketplaceSalesFeeCents ?? null,
    sale.money?.sellerItemNetCents ?? null,
    sale.money?.shippingAllowanceCents ?? null,
    sale.money?.sellerShippingPayoutCents ?? null,
    sale.money?.sellerPayoutCents ?? null,
    sale.refund.refundedOrderTotalCents,
    sale.refund.orderRefundCapCents,
    sale.refund.refundObservedAt,
    sale.capture.atomicAnomalies,
    sale.captureAnomalies,
    sale.refund.anomalies,
    sale.mismatches,
    sale.classificationInputs,
    sale.classificationInputsVersion,
    sale.cancelledAt,
    sale.orderCreatedSourceVersion,
    sale.orderCancelledSourceVersion,
    sale.capture.capturedSourceVersion,
    sale.refund.refundedSourceVersion,
  ];
}

/**
 * Key-sorted, bigint-safe serialization. PostgreSQL `jsonb` does not preserve object key
 * order, so a plain `JSON.stringify` of a stored value would never equal the computed one
 * and every write would look material.
 */
function stableJson(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (typeof entry === "bigint") return entry.toString();
    if (Array.isArray(entry)) return entry.map(canonical);
    if (isRecord(entry)) {
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, canonical(entry[key])]),
      );
    }
    return entry;
  };
  return JSON.stringify(canonical(value));
}

async function writeSaleRow(
  db: PgQueryable,
  paymentId: string,
  orderId: string,
  existing: SaleRow | null,
  sale: MaterializedSale,
  eventRecordedAt: string,
): Promise<void> {
  const money = sale.money;
  const values = [
    paymentId,
    orderId,
    sale.sellerAccountId,
    sale.saleState,
    sale.occurredAt,
    sale.currencyCode,
    sale.capture.payoutSellerAccountId,
    (sale.capture.payout?.marketplaceSalesFeeAmount as string | null | undefined) ?? null,
    (sale.capture.payout?.sellerItemNetAmount as string | null | undefined) ?? null,
    (sale.capture.payout?.shippingAllowanceAmount as string | null | undefined) ?? null,
    (sale.capture.payout?.sellerShippingPayoutAmount as string | null | undefined) ?? null,
    (sale.capture.payout?.protectionAmount as string | null | undefined) ?? null,
    (sale.capture.payout?.protectionAllowanceAmount as string | null | undefined) ?? null,
    (sale.capture.payout?.protectionOverageAmount as string | null | undefined) ?? null,
    (sale.capture.payout?.sellerPayoutAmount as string | null | undefined) ?? null,
    money?.itemGrossCents ?? null,
    money?.shippingChargeCents ?? null,
    money?.salesTaxCents ?? null,
    money?.authenticityFeeCents ?? null,
    money?.protectionCents ?? null,
    money?.protectionAllowanceCents ?? null,
    money?.protectionOverageCents ?? null,
    money?.orderTotalCents ?? null,
    money?.marketplaceSalesFeeCents ?? null,
    money?.sellerItemNetCents ?? null,
    money?.shippingAllowanceCents ?? null,
    money?.sellerShippingPayoutCents ?? null,
    money?.sellerPayoutCents ?? null,
    sale.refund.refundedOrderTotalCents,
    sale.refund.orderRefundCapCents,
    sale.refund.refundObservedAt,
    JSON.stringify(sale.capture.atomicAnomalies),
    JSON.stringify(sale.captureAnomalies),
    JSON.stringify(sale.refund.anomalies),
    JSON.stringify(sale.mismatches),
    JSON.stringify(sale.classificationInputs),
    sale.classificationInputsVersion,
    sale.cancelledAt,
    sale.orderCreatedSourceVersion,
    sale.orderCancelledSourceVersion,
    sale.capture.capturedSourceVersion,
    sale.refund.refundedSourceVersion,
  ].map((value) => (typeof value === "bigint" ? value.toString() : value));

  const completed = isCompletedState(sale.saleState);

  if (existing === null) {
    await db.query(
      `INSERT INTO platform_operations_seller_compliance_sales (
         payment_id, order_id, seller_account_id, sale_state, occurred_at, currency_code,
         capture_payout_seller_account_id,
         capture_marketplace_sales_fee_amount, capture_seller_item_net_amount,
         capture_shipping_allowance_amount, capture_seller_shipping_payout_amount,
         capture_protection_amount, capture_protection_allowance_amount,
         capture_protection_overage_amount, capture_seller_payout_amount,
         item_gross_cents, shipping_charge_cents, sales_tax_cents, authenticity_fee_cents,
         protection_cents, protection_allowance_cents, protection_overage_cents, order_total_cents,
         marketplace_sales_fee_cents, seller_item_net_cents, shipping_allowance_cents,
         seller_shipping_payout_cents, seller_payout_cents,
         refunded_order_total_cents, order_refund_cap_cents, refund_observed_at,
         capture_atomic_anomalies, capture_anomalies, refund_anomalies, reconciliation_mismatches,
         classification_inputs, classification_inputs_version, cancelled_at,
         order_created_source_version, order_cancelled_source_version,
         payment_captured_source_version, payment_refunded_source_version,
         revision, change_sequence, recorded_at, changed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
         $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31,
         $32::jsonb, $33::jsonb, $34::jsonb, $35::jsonb, $36::jsonb, $37, $38, $39, $40, $41, $42,
         1, nextval('platform_operations_seller_compliance_sales_change_seq'), $44, $43
       )`,
      [...values, eventRecordedAt, completed ? eventRecordedAt : null],
    );
    return;
  }

  // `change_sequence` and `changed_at` advance only on a material change; `recorded_at` is
  // assigned exactly once, when the row first reaches a completed state.
  const material = stableJson(materialTuple(sale)) !== stableJson(existingMaterialTuple(existing));
  const result = await db.query(
    `UPDATE platform_operations_seller_compliance_sales SET
       seller_account_id = $3, sale_state = $4, occurred_at = $5, currency_code = $6,
       capture_payout_seller_account_id = $7,
       capture_marketplace_sales_fee_amount = $8, capture_seller_item_net_amount = $9,
       capture_shipping_allowance_amount = $10, capture_seller_shipping_payout_amount = $11,
       capture_protection_amount = $12, capture_protection_allowance_amount = $13,
       capture_protection_overage_amount = $14, capture_seller_payout_amount = $15,
       item_gross_cents = $16, shipping_charge_cents = $17, sales_tax_cents = $18,
       authenticity_fee_cents = $19, protection_cents = $20, protection_allowance_cents = $21,
       protection_overage_cents = $22, order_total_cents = $23, marketplace_sales_fee_cents = $24,
       seller_item_net_cents = $25, shipping_allowance_cents = $26,
       seller_shipping_payout_cents = $27, seller_payout_cents = $28,
       refunded_order_total_cents = $29, order_refund_cap_cents = $30, refund_observed_at = $31,
       capture_atomic_anomalies = $32::jsonb, capture_anomalies = $33::jsonb,
       refund_anomalies = $34::jsonb, reconciliation_mismatches = $35::jsonb,
       classification_inputs = $36::jsonb, classification_inputs_version = $37, cancelled_at = $38,
       order_created_source_version = $39, order_cancelled_source_version = $40,
       payment_captured_source_version = $41, payment_refunded_source_version = $42,
       revision = platform_operations_seller_compliance_sales.revision + 1,
       change_sequence = CASE
         WHEN $45 THEN nextval('platform_operations_seller_compliance_sales_change_seq')
         ELSE platform_operations_seller_compliance_sales.change_sequence
       END,
       recorded_at = COALESCE(platform_operations_seller_compliance_sales.recorded_at, $44),
       changed_at = CASE WHEN $45 THEN $43 ELSE platform_operations_seller_compliance_sales.changed_at END
     WHERE payment_id = $1 AND order_id = $2 AND revision = $46`,
    [...values, eventRecordedAt, completed ? eventRecordedAt : null, material, existing.revision],
  );
  if (result.rowCount === 0) {
    throw new Error(
      `Seller compliance sale ${paymentId}/${orderId} changed concurrently at revision ${existing.revision}; the projection retries rather than clobbering the newer writer.`,
    );
  }
}

/** The stored counterpart of `materialTuple`, read back from the row this write replaces. */
function existingMaterialTuple(existing: SaleRow): unknown[] {
  return [
    existing.seller_account_id,
    existing.sale_state,
    toIsoOrNull(existing.occurred_at),
    existing.currency_code,
    existing.capture_payout_seller_account_id,
    existing.capture_marketplace_sales_fee_amount,
    existing.capture_seller_item_net_amount,
    existing.capture_shipping_allowance_amount,
    existing.capture_seller_shipping_payout_amount,
    existing.capture_protection_amount,
    existing.capture_protection_allowance_amount,
    existing.capture_protection_overage_amount,
    existing.capture_seller_payout_amount,
    ...storedMoneyTuple(existing),
    toBigIntOrNull(existing.refunded_order_total_cents),
    toBigIntOrNull(existing.order_refund_cap_cents),
    toIsoOrNull(existing.refund_observed_at),
    asStringArray(existing.capture_atomic_anomalies),
    storedCaptureAnomalies(existing),
    asStringArray(existing.refund_anomalies),
    storedMismatches(existing),
    storedClassificationInputs(existing),
    storedClassificationVersion(existing),
    storedCancelledAt(existing),
    storedOrderCreatedVersion(existing),
    storedOrderCancelledVersion(existing),
    toNumberOrNull(existing.payment_captured_source_version),
    toNumberOrNull(existing.payment_refunded_source_version),
  ].map((value) => (value === undefined ? null : value)) as unknown[];
}

/*
 * `SELECT *` returns every column, but the narrow `SaleRow` type above only declares the
 * ones the handlers read directly. The material comparison needs the remaining stored
 * columns, so they are read through one widened accessor rather than by widening the type
 * every handler uses.
 */
type StoredSaleRow = SaleRow & Readonly<Record<string, unknown>>;

function storedMoneyTuple(existing: SaleRow): (bigint | null)[] {
  const row = existing as StoredSaleRow;
  return [
    "item_gross_cents",
    "shipping_charge_cents",
    "sales_tax_cents",
    "authenticity_fee_cents",
    "protection_cents",
    "protection_allowance_cents",
    "protection_overage_cents",
    "order_total_cents",
    "marketplace_sales_fee_cents",
    "seller_item_net_cents",
    "shipping_allowance_cents",
    "seller_shipping_payout_cents",
    "seller_payout_cents",
  ].map((column) => {
    const value = row[column];
    return typeof value === "string" ? BigInt(value) : null;
  });
}

function storedCaptureAnomalies(existing: SaleRow): string[] {
  return asStringArray((existing as StoredSaleRow).capture_anomalies);
}

function storedMismatches(existing: SaleRow): string[] {
  return asStringArray((existing as StoredSaleRow).reconciliation_mismatches);
}

function storedClassificationInputs(existing: SaleRow): unknown {
  return (existing as StoredSaleRow).classification_inputs ?? [];
}

function storedClassificationVersion(existing: SaleRow): number {
  const value = (existing as StoredSaleRow).classification_inputs_version;
  return typeof value === "number" ? value : Number(value ?? 1);
}

function storedCancelledAt(existing: SaleRow): string | null {
  const value = (existing as StoredSaleRow).cancelled_at;
  return value instanceof Date ? value.toISOString() : null;
}

function storedOrderCreatedVersion(existing: SaleRow): number | null {
  const value = (existing as StoredSaleRow).order_created_source_version;
  return typeof value === "string" ? Number(value) : null;
}

function storedOrderCancelledVersion(existing: SaleRow): number | null {
  const value = (existing as StoredSaleRow).order_cancelled_source_version;
  return typeof value === "string" ? Number(value) : null;
}

function retainedCaptureFacts(existing: SaleRow | null): RetainedCaptureFacts {
  if (existing === null) {
    return {
      occurredAt: null,
      currencyCode: null,
      payoutSellerAccountId: null,
      payout: null,
      atomicAnomalies: [],
      capturedSourceVersion: null,
    };
  }
  return {
    occurredAt: toIsoOrNull(existing.occurred_at),
    currencyCode: existing.currency_code,
    payoutSellerAccountId: existing.capture_payout_seller_account_id,
    payout: payoutFromRow(existing),
    atomicAnomalies: asStringArray(existing.capture_atomic_anomalies) as CaptureAnomaly[],
    capturedSourceVersion: toNumberOrNull(existing.payment_captured_source_version),
  };
}

function retainedRefundFacts(existing: SaleRow | null): RetainedRefundFacts {
  if (existing === null) {
    return {
      refundedOrderTotalCents: null,
      orderRefundCapCents: null,
      refundObservedAt: null,
      anomalies: [],
      refundedSourceVersion: null,
    };
  }
  return {
    refundedOrderTotalCents: toBigIntOrNull(existing.refunded_order_total_cents),
    orderRefundCapCents: toBigIntOrNull(existing.order_refund_cap_cents),
    refundObservedAt: toIsoOrNull(existing.refund_observed_at),
    anomalies: asStringArray(existing.refund_anomalies) as RefundAnomaly[],
    refundedSourceVersion: toNumberOrNull(existing.payment_refunded_source_version),
  };
}

/** Re-materializes every sale row for an order after its Ordering facts change. */
async function refreshSalesForOrder(db: PgQueryable, orderId: string, eventRecordedAt: string): Promise<void> {
  const orderFact = await lockOrderFact(db, orderId);
  const paymentIds = await db.query<{ payment_id: string }>(
    `SELECT payment_id FROM platform_operations_seller_compliance_sales WHERE order_id = $1 ORDER BY payment_id ASC`,
    [orderId],
  );
  for (const { payment_id: paymentId } of paymentIds.rows) {
    const existing = await lockSaleRow(db, paymentId, orderId);
    if (existing === null) continue;
    const sale = materializeSale(orderFact, retainedCaptureFacts(existing), retainedRefundFacts(existing));
    await writeSaleRow(db, paymentId, orderId, existing, sale, eventRecordedAt);
  }
}

async function writeOrderFact(
  db: PgQueryable,
  existing: OrderFactRow | null,
  next: Readonly<{
    orderId: string;
    sellerAccountId: string | null;
    money: OrderMoneyFact | null;
    classificationInputs: readonly ClassificationInput[] | null;
    cancelledAt: string | null;
    lifecycleState: OrderFactLifecycleState;
    orderCreatedSourceVersion: number | null;
    orderCancelledSourceVersion: number | null;
  }>,
  eventRecordedAt: string,
): Promise<void> {
  const values = [
    next.orderId,
    next.sellerAccountId,
    next.money?.itemSubtotalAmount ?? null,
    next.money?.shippingChargeAmount ?? null,
    next.money?.shippingAllowanceAmount ?? null,
    next.money?.salesTaxAmount ?? null,
    next.money?.authenticityFeeAmount ?? null,
    next.money?.protectionAmount ?? null,
    next.money?.protectionAllowanceAmount ?? null,
    next.money?.protectionOverageAmount ?? null,
    next.money?.orderTotalAmount ?? null,
    JSON.stringify(next.classificationInputs ?? []),
    CLASSIFICATION_INPUTS_VERSION,
    next.orderCreatedSourceVersion,
    next.orderCancelledSourceVersion,
    next.cancelledAt,
    next.lifecycleState,
  ];

  if (existing === null) {
    await db.query(
      `INSERT INTO platform_operations_seller_compliance_order_facts (
         order_id, seller_account_id, item_subtotal_amount, shipping_charge_amount,
         shipping_allowance_amount, sales_tax_amount, authenticity_fee_amount, protection_amount,
         protection_allowance_amount, protection_overage_amount, order_total_amount,
         classification_inputs, classification_inputs_version,
         order_created_source_version, order_cancelled_source_version, cancelled_at, lifecycle_state,
         revision, first_observed_at, changed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, 1, $18, $18
       )`,
      [...values, eventRecordedAt],
    );
    return;
  }

  const result = await db.query(
    `UPDATE platform_operations_seller_compliance_order_facts SET
       seller_account_id = $2, item_subtotal_amount = $3, shipping_charge_amount = $4,
       shipping_allowance_amount = $5, sales_tax_amount = $6, authenticity_fee_amount = $7,
       protection_amount = $8, protection_allowance_amount = $9, protection_overage_amount = $10,
       order_total_amount = $11, classification_inputs = $12::jsonb, classification_inputs_version = $13,
       order_created_source_version = $14, order_cancelled_source_version = $15,
       cancelled_at = $16, lifecycle_state = $17,
       revision = platform_operations_seller_compliance_order_facts.revision + 1,
       changed_at = $18
     WHERE order_id = $1 AND revision = $19`,
    [...values, eventRecordedAt, existing.revision],
  );
  if (result.rowCount === 0) {
    throw new Error(
      `Seller compliance order fact ${next.orderId} changed concurrently at revision ${existing.revision}; the projection retries rather than clobbering the newer writer.`,
    );
  }
}

/**
 * Ordering owns the seller, the order money decomposition, the classification inputs, and
 * cancellation. Created and cancelled retain separate source versions so a cancellation can
 * never erase creation fields and a stale redelivery of either updates nothing.
 */
export function buildOrderingSellerComplianceSalesProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "ordering.order.created": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as Readonly<Record<string, unknown>>;
      const orderId = String(data.orderId ?? "");
      if (orderId.length === 0) return;

      await lockOrderScope(projectionDb, orderId);
      const existing = await lockOrderFact(projectionDb, orderId);
      if (isStaleGroupVersion(existing?.order_created_source_version ?? null, event.streamVersion)) {
        return;
      }

      const authenticity = isRecord(data.authenticityPlanSnapshot) ? data.authenticityPlanSnapshot : null;
      await writeOrderFact(
        projectionDb,
        existing,
        {
          orderId,
          sellerAccountId: isNonEmptyString(data.sellerAccountId) ? data.sellerAccountId : null,
          money: {
            itemSubtotalAmount: asMoneyStringOrNull(data.itemSubtotalAmount),
            shippingChargeAmount: asMoneyStringOrNull(data.shippingChargeAmount),
            shippingAllowanceAmount: asMoneyStringOrNull(data.shippingAllowanceAmount),
            salesTaxAmount: asMoneyStringOrNull(data.salesTaxAmount),
            // A null authenticity plan is Ordering's authoritative no-fee value: its own
            // total invariant adds exactly "0.00" for it. Every other absent string stays null.
            authenticityFeeAmount: authenticity === null ? "0.00" : asMoneyStringOrNull(authenticity.feeAmount),
            protectionAmount: asMoneyStringOrNull(data.protectionAmount),
            protectionAllowanceAmount: asMoneyStringOrNull(data.protectionAllowanceAmount),
            protectionOverageAmount: asMoneyStringOrNull(data.protectionOverageAmount),
            orderTotalAmount: asMoneyStringOrNull(data.totalAmount),
          },
          classificationInputs: extractClassificationInputs(data.lines),
          cancelledAt: existing === null ? null : toIsoOrNull(existing.cancelled_at),
          lifecycleState:
            existing !== null && existing.cancelled_at !== null ? "cancelled-awaiting-capture" : "awaiting-capture",
          orderCreatedSourceVersion: event.streamVersion,
          orderCancelledSourceVersion:
            existing === null ? null : toNumberOrNull(existing.order_cancelled_source_version),
        },
        event.timing.recordedAt,
      );
      await refreshSalesForOrder(projectionDb, orderId, event.timing.recordedAt);
    },
    "ordering.order.cancelled": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as Readonly<Record<string, unknown>>;
      const orderId = String(data.orderId ?? "");
      if (orderId.length === 0) return;

      await lockOrderScope(projectionDb, orderId);
      const existing = await lockOrderFact(projectionDb, orderId);
      if (isStaleGroupVersion(existing?.order_cancelled_source_version ?? null, event.streamVersion)) {
        return;
      }

      // Cancellation changes only cancellation and version metadata; every retained
      // creation field is carried forward untouched, so money is never rewritten.
      await writeOrderFact(
        projectionDb,
        existing,
        {
          orderId,
          sellerAccountId: existing?.seller_account_id ?? null,
          money: orderMoneyFromRow(existing),
          classificationInputs: (existing?.classification_inputs as ClassificationInput[] | undefined) ?? [],
          cancelledAt: isNonEmptyString(data.cancelledAt) ? data.cancelledAt : event.timing.occurredAt,
          lifecycleState: "cancelled-awaiting-capture",
          orderCreatedSourceVersion: existing === null ? null : toNumberOrNull(existing.order_created_source_version),
          orderCancelledSourceVersion: event.streamVersion,
        },
        event.timing.recordedAt,
      );
      await refreshSalesForOrder(projectionDb, orderId, event.timing.recordedAt);
    },
  };
}

function asMoneyStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Payments owns capture and refund. Both write their own source version, so a refund
 * delivered before its capture cannot suppress the later, lower-versioned capture group.
 */
export function buildPaymentsSellerComplianceSalesProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "payments.payment-captured": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as unknown as CaptureFact;
      const paymentId = String(data.paymentId ?? "");
      if (paymentId.length === 0) return;

      const atomicAnomalies = classifyCaptureAtomicAnomalies(data);
      const occurredAt = isNonEmptyString(data.capturedAt) ? data.capturedAt : event.timing.occurredAt;
      // A fixed lock order over the affected orders keeps concurrent captures deadlock-free.
      for (const orderId of distinctOrderIds(data.orderIds).sort()) {
        await lockOrderScope(projectionDb, orderId);
        const orderFact = await lockOrderFact(projectionDb, orderId);
        const existing = await lockSaleRow(projectionDb, paymentId, orderId);
        if (isStaleGroupVersion(existing?.payment_captured_source_version ?? null, event.streamVersion)) {
          continue;
        }
        const payout = selectCapturePayout(data, orderId);
        const capture: RetainedCaptureFacts = {
          occurredAt,
          currencyCode: isNonEmptyString(data.currencyCode) ? data.currencyCode : null,
          payoutSellerAccountId: isNonEmptyString(payout?.sellerAccountId) ? payout.sellerAccountId : null,
          payout,
          atomicAnomalies,
          capturedSourceVersion: event.streamVersion,
        };
        const sale = materializeSale(orderFact, capture, retainedRefundFacts(existing));
        await writeSaleRow(projectionDb, paymentId, orderId, existing, sale, event.timing.recordedAt);
      }
    },
    "payments.payment-refunded": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as unknown as RefundFact;
      const paymentId = String(data.paymentId ?? "");
      if (paymentId.length === 0) return;

      const membership = await readCaptureMembership(projectionDb, paymentId);
      const refundObservedAt = isNonEmptyString(data.refundedAt) ? data.refundedAt : event.timing.occurredAt;
      for (const orderId of distinctOrderIds(data.orderIds).sort()) {
        await lockOrderScope(projectionDb, orderId);
        const orderFact = await lockOrderFact(projectionDb, orderId);
        const existing = await lockSaleRow(projectionDb, paymentId, orderId);
        if (isStaleGroupVersion(existing?.payment_refunded_source_version ?? null, event.streamVersion)) {
          continue;
        }
        const affected = selectAffectedRefundFact(data, orderId, membership);
        const refund: RetainedRefundFacts = {
          refundedOrderTotalCents: affected.refundedOrderTotalCents,
          orderRefundCapCents: affected.orderRefundCapCents,
          refundObservedAt,
          anomalies: affected.anomalies,
          refundedSourceVersion: event.streamVersion,
        };
        const sale = materializeSale(orderFact, retainedCaptureFacts(existing), refund);
        await writeSaleRow(projectionDb, paymentId, orderId, existing, sale, event.timing.recordedAt);
      }
    },
  };
}
