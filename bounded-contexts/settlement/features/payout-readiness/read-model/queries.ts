import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type SettlementPayoutReadinessRow = Readonly<{
  account_id: string;
  status: "not-started" | "pending" | "ready" | "restricted";
  missing_requirements: readonly string[];
  provider_reference: string | null;
  updated_at: string | null;
}>;

type PayoutReadinessPageRow = Omit<
  SettlementPayoutReadinessRow,
  "status" | "missing_requirements"
> & Readonly<{
  status: string;
  missing_requirements: unknown;
}>;

function normalizeStatus(status: string): SettlementPayoutReadinessRow["status"] {
  switch (status) {
    case "pending":
    case "ready":
    case "restricted":
      return status;
    default:
      return "not-started";
  }
}

function mapPayoutReadiness(row: PayoutReadinessPageRow): SettlementPayoutReadinessRow {
  return {
    ...row,
    status: normalizeStatus(row.status),
    missing_requirements: Array.isArray(row.missing_requirements)
      ? row.missing_requirements.filter((value): value is string => typeof value === "string")
      : [],
  };
}

export function createEmptyPayoutReadiness(
  accountId: string,
): SettlementPayoutReadinessRow {
  return {
    account_id: accountId,
    status: "not-started",
    missing_requirements: ["provider-onboarding", "seller-agreement"],
    provider_reference: null,
    updated_at: null,
  };
}

export async function getPayoutReadiness(
  db: PgQueryable,
  accountId: string,
): Promise<SettlementPayoutReadinessRow> {
  const result = await db.query<PayoutReadinessPageRow>(
    `SELECT
       account_id,
       status,
       missing_requirements,
       provider_reference,
       updated_at
     FROM settlement_payout_readiness_pages
     WHERE account_id = $1`,
    [accountId],
  );

  const row = result.rows[0];
  return row ? mapPayoutReadiness(row) : createEmptyPayoutReadiness(accountId);
}
