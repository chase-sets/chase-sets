import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Read-model queries for the ProtectionCoverage slice. These serve
 * operators and metrics; they never expose internal ledger postings to
 * customers. Availability is reported from the projected reservation ledger plus
 * the funded pool (contributions − reversals) owned by the contribution read
 * model, matching the authoritative pool-aggregate formula.
 */

export type ProtectionCoverageRow = Readonly<{
  coverage_id: string;
  remedy_id: string;
  support_request_id: string;
  currency_code: string;
  reserved_amount: string;
  consumed_amount: string;
  released_amount: string;
  status: "reserved" | "settled" | "released" | "expired";
  refund_id: string | null;
  policy_version: string;
  reason_code: string | null;
  reserved_at: string;
  terminal_at: string | null;
  updated_at: string;
}>;

export type ProtectionCoverageAvailability = Readonly<{
  fundedAmount: string;
  outstandingReservedAmount: string;
  consumedAmount: string;
  releasedAmount: string;
  availableAmount: string;
}>;

export type ProtectionCoverageMetrics = Readonly<{
  requested: number;
  reserved: number;
  rejected: number;
  settled: number;
  released: number;
  expired: number;
  stuck: number;
}>;

/** Net protection pool: contributions minus reversals, all-time. This is the funded ceiling. */
export async function getProtectionReservePoolBalance(db: PgQueryable): Promise<string> {
  const result = await db.query<{ funded_amount: string }>(
    `SELECT COALESCE(
       SUM(CASE WHEN fact_kind = 'contribution' THEN protection_amount ELSE -protection_amount END),
       0
     )::text AS funded_amount
     FROM settlement_protection_reserve_facts`,
  );
  return result.rows[0]?.funded_amount ?? "0.00";
}

/**
 * Available protection funds for new reservations:
 * funded − outstanding-reserved − consumed. Mirrors the pool aggregate's
 * `availableProtectionAmount`, computed from the convergent projection.
 */
export async function getProtectionCoverageAvailability(db: PgQueryable): Promise<ProtectionCoverageAvailability> {
  const funded = await getProtectionReservePoolBalance(db);
  const result = await db.query<{
    outstanding_reserved: string;
    consumed: string;
    released: string;
  }>(
    `SELECT
       COALESCE(SUM(reserved_amount) FILTER (WHERE status = 'reserved'), 0)::text AS outstanding_reserved,
       COALESCE(SUM(consumed_amount) FILTER (WHERE status = 'settled'), 0)::text AS consumed,
       COALESCE(SUM(released_amount) FILTER (WHERE status IN ('released', 'expired')), 0)::text AS released
     FROM settlement_protection_coverage`,
  );
  const row = result.rows[0] ?? { outstanding_reserved: "0.00", consumed: "0.00", released: "0.00" };
  const availableCents =
    Math.round(Number(funded) * 100) -
    Math.round(Number(row.outstanding_reserved) * 100) -
    Math.round(Number(row.consumed) * 100);
  return {
    fundedAmount: funded,
    outstandingReservedAmount: row.outstanding_reserved,
    consumedAmount: row.consumed,
    releasedAmount: row.released,
    availableAmount: (availableCents / 100).toFixed(2),
  };
}

export async function getProtectionCoverage(
  db: PgQueryable,
  coverageId: string,
): Promise<ProtectionCoverageRow | null> {
  const result = await db.query<ProtectionCoverageRow>(
    `SELECT coverage_id, remedy_id, support_request_id, currency_code,
            reserved_amount::text AS reserved_amount,
            consumed_amount::text AS consumed_amount,
            released_amount::text AS released_amount,
            status, refund_id, policy_version, reason_code,
            reserved_at, terminal_at, updated_at
     FROM settlement_protection_coverage
     WHERE coverage_id = $1`,
    [coverageId],
  );
  return result.rows[0] ?? null;
}

/**
 * A reserved coverage is "reconciled" once it reaches a terminal state
 * (settled/released/expired). A reservation that stays `reserved` past the
 * stuck threshold is the operator's blocking signal — the refund/allocation
 * never arrived, or expiry never ran.
 */
export type ProtectionCoverageReconciliationRow = ProtectionCoverageRow &
  Readonly<{ reconciliation_status: "pending" | "reconciled"; blocking_reason: string | null }>;

export async function listProtectionCoverageReconciliation(
  db: PgQueryable,
  params: Readonly<{ status?: ProtectionCoverageRow["status"]; limit?: number; offset?: number }> = {},
): Promise<ProtectionCoverageReconciliationRow[]> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);
  const filters: string[] = [];
  const values: unknown[] = [];
  if (params.status) {
    values.push(params.status);
    filters.push(`status = $${values.length}`);
  }
  values.push(limit);
  values.push(offset);
  const result = await db.query<ProtectionCoverageReconciliationRow>(
    `SELECT coverage_id, remedy_id, support_request_id, currency_code,
            reserved_amount::text AS reserved_amount,
            consumed_amount::text AS consumed_amount,
            released_amount::text AS released_amount,
            status, refund_id, policy_version, reason_code,
            reserved_at, terminal_at, updated_at,
            CASE WHEN status = 'reserved' THEN 'pending' ELSE 'reconciled' END AS reconciliation_status,
            CASE WHEN status = 'reserved' THEN 'awaiting-settlement-or-release' ELSE NULL END AS blocking_reason
     FROM settlement_protection_coverage
     ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
     ORDER BY reserved_at DESC, coverage_id DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return result.rows;
}

/**
 * Lifecycle counts for monitoring: requested, reserved, rejected, settled
 * (consumed), released, expired, and stuck (reserved past the threshold).
 */
export async function getProtectionCoverageMetrics(
  db: PgQueryable,
  params: Readonly<{ stuckOlderThanMinutes?: number; now?: string }> = {},
): Promise<ProtectionCoverageMetrics> {
  const stuckMinutes = params.stuckOlderThanMinutes ?? 60 * 24;
  const nowIso = params.now ?? new Date().toISOString();
  const stuckBefore = new Date(Date.parse(nowIso) - stuckMinutes * 60 * 1000).toISOString();

  const lifecycle = await db.query<{
    reserved: string;
    settled: string;
    released: string;
    expired: string;
    stuck: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'reserved')::text AS reserved,
       COUNT(*) FILTER (WHERE status = 'settled')::text AS settled,
       COUNT(*) FILTER (WHERE status = 'released')::text AS released,
       COUNT(*) FILTER (WHERE status = 'expired')::text AS expired,
       COUNT(*) FILTER (WHERE status = 'reserved' AND reserved_at < $1::timestamptz)::text AS stuck
     FROM settlement_protection_coverage`,
    [stuckBefore],
  );
  const rejectedResult = await db.query<{ rejected: string }>(
    `SELECT COUNT(*)::text AS rejected FROM settlement_protection_coverage_rejections`,
  );
  const row = lifecycle.rows[0] ?? { reserved: "0", settled: "0", released: "0", expired: "0", stuck: "0" };
  const rejected = Number(rejectedResult.rows[0]?.rejected ?? "0");
  const reserved = Number(row.reserved);
  const settled = Number(row.settled);
  const released = Number(row.released);
  const expired = Number(row.expired);
  return {
    reserved,
    settled,
    released,
    expired,
    rejected,
    stuck: Number(row.stuck),
    // Every reservation that entered a lifecycle state plus every refused request.
    requested: reserved + settled + released + expired + rejected,
  };
}
