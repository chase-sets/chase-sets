import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { LiabilityFundingKind } from "@chase-sets/primitives/platform-coverage";
import type { AuthorizedRefundAllocation, RefundLiabilityQuarantineReason } from "../domain/liability-allocation";

/**
 * Persistence helpers for `settlement_refund_liability_allocations`. These are the
 * only writers/readers of the reconciliation record; the projection composes them so
 * a refund's authorization, reconciliation, and quarantine converge on one row keyed
 * by the stable `refundId`.
 */

export type StoredRefundAllocationRow = AuthorizedRefundAllocation &
  Readonly<{
    reconciliationStatus: "authorized" | "reconciled" | "quarantined";
    completedRefundAmount: string | null;
    lastStreamVersion: number;
  }>;

/**
 * Records the authorized allocation carried by a Payments refund-causation fact,
 * before the refund completes. A replay of the authorization must not clobber a row
 * that has already reconciled or quarantined, so the upsert only advances an existing
 * `authorized` row and only for a newer stream position.
 */
export async function recordAuthorizedRefundAllocation(
  db: PgQueryable,
  input: Readonly<{
    refundId: string;
    paymentId: string | null;
    remedyId: string;
    coverageId: string | null;
    sellerFundedAmount: string;
    platformFundedAmount: string;
    currencyCode: string;
    fundingKind: LiabilityFundingKind;
    authorizedAt: string;
    streamVersion: number;
  }>,
): Promise<void> {
  await db.query(
    `INSERT INTO settlement_refund_liability_allocations (
       refund_id, payment_id, remedy_id, coverage_id, currency_code,
       seller_funded_amount, platform_funded_amount, funding_kind,
       reconciliation_status, authorized_at, updated_at, last_stream_version
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, 'authorized', $9, $9, $10
     )
     ON CONFLICT (refund_id) DO UPDATE
     SET payment_id = COALESCE(EXCLUDED.payment_id, settlement_refund_liability_allocations.payment_id),
         remedy_id = EXCLUDED.remedy_id,
         coverage_id = EXCLUDED.coverage_id,
         currency_code = EXCLUDED.currency_code,
         seller_funded_amount = EXCLUDED.seller_funded_amount,
         platform_funded_amount = EXCLUDED.platform_funded_amount,
         funding_kind = EXCLUDED.funding_kind,
         authorized_at = EXCLUDED.authorized_at,
         updated_at = EXCLUDED.updated_at,
         last_stream_version = EXCLUDED.last_stream_version
     WHERE settlement_refund_liability_allocations.reconciliation_status = 'authorized'
       AND settlement_refund_liability_allocations.last_stream_version < EXCLUDED.last_stream_version`,
    [
      input.refundId,
      input.paymentId,
      input.remedyId,
      input.coverageId,
      input.currencyCode,
      input.sellerFundedAmount,
      input.platformFundedAmount,
      input.fundingKind,
      input.authorizedAt,
      input.streamVersion,
    ],
  );
}

/** Loads the authorized allocation for a refund, or `null` when none was recorded (seller-funded default). */
export async function loadRefundAllocation(
  db: PgQueryable,
  refundId: string,
): Promise<StoredRefundAllocationRow | null> {
  const result = await db.query<{
    refund_id: string;
    remedy_id: string;
    coverage_id: string | null;
    seller_funded_amount: string;
    platform_funded_amount: string;
    currency_code: string;
    funding_kind: LiabilityFundingKind;
    reconciliation_status: "authorized" | "reconciled" | "quarantined";
    completed_refund_amount: string | null;
    last_stream_version: number;
  }>(
    `SELECT refund_id, remedy_id, coverage_id,
            seller_funded_amount::text AS seller_funded_amount,
            platform_funded_amount::text AS platform_funded_amount,
            currency_code, funding_kind, reconciliation_status,
            completed_refund_amount::text AS completed_refund_amount,
            last_stream_version
     FROM settlement_refund_liability_allocations
     WHERE refund_id = $1`,
    [refundId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    refundId: row.refund_id,
    remedyId: row.remedy_id,
    coverageId: row.coverage_id,
    sellerFundedAmount: row.seller_funded_amount,
    platformFundedAmount: row.platform_funded_amount,
    currencyCode: row.currency_code,
    fundingKind: row.funding_kind,
    reconciliationStatus: row.reconciliation_status,
    completedRefundAmount: row.completed_refund_amount,
    lastStreamVersion: row.last_stream_version,
  };
}

/**
 * Records a completed refund's reconciliation: the exact seller portion posted to the
 * ledger and the platform portion consumed from the reserved coverage. Upserts because
 * a seller-funded refund may have no prior authorized row (no causation was carried).
 */
export async function recordReconciledRefundLiability(
  db: PgQueryable,
  input: Readonly<{
    refundId: string;
    paymentId: string | null;
    remedyId: string;
    coverageId: string | null;
    sellerFundedAmount: string;
    platformFundedAmount: string;
    currencyCode: string;
    fundingKind: LiabilityFundingKind;
    completedRefundAmount: string;
    sellerPostedAmount: string;
    platformSettledAmount: string;
    reconciledAt: string;
    streamVersion: number;
  }>,
): Promise<void> {
  await db.query(
    `INSERT INTO settlement_refund_liability_allocations (
       refund_id, payment_id, remedy_id, coverage_id, currency_code,
       seller_funded_amount, platform_funded_amount, funding_kind,
       completed_refund_amount, seller_posted_amount, platform_settled_amount,
       reconciliation_status, quarantine_reason, quarantine_detail,
       reconciled_at, updated_at, last_stream_version
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'reconciled', NULL, NULL, $12, $12, $13
     )
     ON CONFLICT (refund_id) DO UPDATE
     SET payment_id = COALESCE(EXCLUDED.payment_id, settlement_refund_liability_allocations.payment_id),
         remedy_id = EXCLUDED.remedy_id,
         coverage_id = EXCLUDED.coverage_id,
         currency_code = EXCLUDED.currency_code,
         seller_funded_amount = EXCLUDED.seller_funded_amount,
         platform_funded_amount = EXCLUDED.platform_funded_amount,
         funding_kind = EXCLUDED.funding_kind,
         completed_refund_amount = EXCLUDED.completed_refund_amount,
         seller_posted_amount = EXCLUDED.seller_posted_amount,
         platform_settled_amount = EXCLUDED.platform_settled_amount,
         reconciliation_status = 'reconciled',
         quarantine_reason = NULL,
         quarantine_detail = NULL,
         reconciled_at = EXCLUDED.reconciled_at,
         updated_at = EXCLUDED.updated_at,
         last_stream_version = EXCLUDED.last_stream_version
     WHERE settlement_refund_liability_allocations.reconciliation_status <> 'reconciled'
        OR settlement_refund_liability_allocations.last_stream_version < EXCLUDED.last_stream_version`,
    [
      input.refundId,
      input.paymentId,
      input.remedyId,
      input.coverageId,
      input.currencyCode,
      input.sellerFundedAmount,
      input.platformFundedAmount,
      input.fundingKind,
      input.completedRefundAmount,
      input.sellerPostedAmount,
      input.platformSettledAmount,
      input.reconciledAt,
      input.streamVersion,
    ],
  );
}

/**
 * Records a fail-closed quarantine for a refund whose allocation could not be
 * reconciled. A quarantined row never carries a seller debit or a coverage consumption;
 * it is the observable operator repair queue. A row that already reconciled is never
 * downgraded to quarantined.
 */
export async function recordQuarantinedRefundLiability(
  db: PgQueryable,
  input: Readonly<{
    refundId: string;
    paymentId: string | null;
    remedyId: string;
    coverageId: string | null;
    sellerFundedAmount: string;
    platformFundedAmount: string;
    currencyCode: string;
    fundingKind: LiabilityFundingKind;
    completedRefundAmount: string;
    reasonCode: RefundLiabilityQuarantineReason;
    detail: string;
    quarantinedAt: string;
    streamVersion: number;
  }>,
): Promise<void> {
  await db.query(
    `INSERT INTO settlement_refund_liability_allocations (
       refund_id, payment_id, remedy_id, coverage_id, currency_code,
       seller_funded_amount, platform_funded_amount, funding_kind,
       completed_refund_amount, reconciliation_status, quarantine_reason, quarantine_detail,
       updated_at, last_stream_version
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, 'quarantined', $10, $11, $12, $13
     )
     ON CONFLICT (refund_id) DO UPDATE
     SET payment_id = COALESCE(EXCLUDED.payment_id, settlement_refund_liability_allocations.payment_id),
         remedy_id = EXCLUDED.remedy_id,
         coverage_id = EXCLUDED.coverage_id,
         currency_code = EXCLUDED.currency_code,
         seller_funded_amount = EXCLUDED.seller_funded_amount,
         platform_funded_amount = EXCLUDED.platform_funded_amount,
         funding_kind = EXCLUDED.funding_kind,
         completed_refund_amount = EXCLUDED.completed_refund_amount,
         reconciliation_status = 'quarantined',
         quarantine_reason = EXCLUDED.quarantine_reason,
         quarantine_detail = EXCLUDED.quarantine_detail,
         updated_at = EXCLUDED.updated_at,
         last_stream_version = EXCLUDED.last_stream_version
     WHERE settlement_refund_liability_allocations.reconciliation_status <> 'reconciled'`,
    [
      input.refundId,
      input.paymentId,
      input.remedyId,
      input.coverageId,
      input.currencyCode,
      input.sellerFundedAmount,
      input.platformFundedAmount,
      input.fundingKind,
      input.completedRefundAmount,
      input.reasonCode,
      input.detail,
      input.quarantinedAt,
      input.streamVersion,
    ],
  );
}
