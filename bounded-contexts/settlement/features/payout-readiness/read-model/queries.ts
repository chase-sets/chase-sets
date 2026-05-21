import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type SettlementPayoutReadinessRow = Readonly<{
  account_id: string;
  status: "not-started" | "pending" | "ready" | "restricted";
  missing_requirements: readonly string[];
  provider_reference: string | null;
  onboarding_status: "not-started" | "pending" | "complete";
  transfer_capability_status: "inactive" | "pending" | "active";
  payout_capability_status: "inactive" | "pending" | "active";
  payout_destination_status: "missing" | "pending" | "ready";
  updated_at: string | null;
}>;

type PayoutReadinessPageRow = Omit<SettlementPayoutReadinessRow, "status" | "missing_requirements"> &
  Readonly<{
    status: string;
    missing_requirements: unknown;
    onboarding_status: string;
    transfer_capability_status: string;
    payout_capability_status: string;
    payout_destination_status: string;
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

function normalizeOnboardingStatus(status: string): SettlementPayoutReadinessRow["onboarding_status"] {
  switch (status) {
    case "pending":
    case "complete":
      return status;
    default:
      return "not-started";
  }
}

function normalizeCapabilityStatus(status: string): SettlementPayoutReadinessRow["transfer_capability_status"] {
  switch (status) {
    case "pending":
    case "active":
      return status;
    default:
      return "inactive";
  }
}

function normalizeDestinationStatus(status: string): SettlementPayoutReadinessRow["payout_destination_status"] {
  switch (status) {
    case "pending":
    case "ready":
      return status;
    default:
      return "missing";
  }
}

function mapPayoutReadiness(row: PayoutReadinessPageRow): SettlementPayoutReadinessRow {
  return {
    ...row,
    status: normalizeStatus(row.status),
    onboarding_status: normalizeOnboardingStatus(row.onboarding_status),
    transfer_capability_status: normalizeCapabilityStatus(row.transfer_capability_status),
    payout_capability_status: normalizeCapabilityStatus(row.payout_capability_status),
    payout_destination_status: normalizeDestinationStatus(row.payout_destination_status),
    missing_requirements: Array.isArray(row.missing_requirements)
      ? row.missing_requirements.filter((value): value is string => typeof value === "string")
      : [],
  };
}

export function createEmptyPayoutReadiness(accountId: string): SettlementPayoutReadinessRow {
  return {
    account_id: accountId,
    status: "not-started",
    missing_requirements: ["provider-onboarding", "seller-agreement"],
    provider_reference: null,
    onboarding_status: "not-started",
    transfer_capability_status: "inactive",
    payout_capability_status: "inactive",
    payout_destination_status: "missing",
    updated_at: null,
  };
}

export async function getPayoutReadiness(db: PgQueryable, accountId: string): Promise<SettlementPayoutReadinessRow> {
  const result = await db.query<PayoutReadinessPageRow>(
    `SELECT
       account_id,
       status,
       missing_requirements,
       provider_reference,
       onboarding_status,
       transfer_capability_status,
       payout_capability_status,
       payout_destination_status,
       updated_at
     FROM settlement_payout_readiness_pages
     WHERE account_id = $1`,
    [accountId],
  );

  const row = result.rows[0];
  return row ? mapPayoutReadiness(row) : createEmptyPayoutReadiness(accountId);
}

export async function getPayoutReadinessByProviderReference(
  db: PgQueryable,
  providerReference: string,
): Promise<SettlementPayoutReadinessRow | null> {
  const result = await db.query<PayoutReadinessPageRow>(
    `SELECT
       account_id,
       status,
       missing_requirements,
       provider_reference,
       onboarding_status,
       transfer_capability_status,
       payout_capability_status,
       payout_destination_status,
       updated_at
     FROM settlement_payout_readiness_pages
     WHERE provider_reference = $1`,
    [providerReference],
  );

  const row = result.rows[0];
  return row ? mapPayoutReadiness(row) : null;
}
