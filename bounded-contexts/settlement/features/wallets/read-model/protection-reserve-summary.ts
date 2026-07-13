import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type ProtectionReserveSummary = Readonly<{
  contributionAmount: string;
  allowanceAmount: string;
  overageAmount: string;
  reversalAmount: string;
  coveredOrderCount: number;
}>;

export async function getProtectionReserveSummary(
  db: PgQueryable,
  params: Readonly<{ from: string; to: string }>,
): Promise<ProtectionReserveSummary> {
  const toExclusive = new Date(`${params.to}T00:00:00.000Z`);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  const result = await db.query<ProtectionReserveSummary>(
    `SELECT
       COALESCE(SUM(CASE WHEN fact_kind = 'contribution' THEN protection_amount ELSE -protection_amount END), 0)::text AS "contributionAmount",
       COALESCE(SUM(CASE WHEN fact_kind = 'contribution' THEN allowance_amount ELSE -allowance_amount END), 0)::text AS "allowanceAmount",
       COALESCE(SUM(CASE WHEN fact_kind = 'contribution' THEN overage_amount ELSE -overage_amount END), 0)::text AS "overageAmount",
       COALESCE(SUM(CASE WHEN fact_kind = 'reversal' THEN protection_amount ELSE 0 END), 0)::text AS "reversalAmount",
       COUNT(DISTINCT order_id) FILTER (WHERE fact_kind = 'contribution')::integer AS "coveredOrderCount"
     FROM settlement_protection_reserve_facts
     WHERE recorded_at >= $1::timestamptz
       AND recorded_at < $2::timestamptz`,
    [`${params.from}T00:00:00.000Z`, toExclusive.toISOString()],
  );
  return (
    result.rows[0] ?? {
      contributionAmount: "0.00",
      allowanceAmount: "0.00",
      overageAmount: "0.00",
      reversalAmount: "0.00",
      coveredOrderCount: 0,
    }
  );
}
