import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type SettlementPayoutReadinessRow = Readonly<{
  account_id: string;
  status: "not-started" | "pending" | "ready" | "restricted";
  missing_requirements: readonly string[];
  advisory_requirements: readonly string[];
  disabled_reason: string | null;
  requirements_deadline: string | null;
  provider_reference: string | null;
  contact_email: string | null;
  onboarding_status: "not-started" | "pending" | "complete";
  transfer_capability_status: "inactive" | "pending" | "active";
  payout_capability_status: "inactive" | "pending" | "active";
  payout_destination_status: "missing" | "pending" | "ready";
  payout_destination_fingerprint: string | null;
  payout_destination_changed_at: string | null;
  payout_account_dashboard: "none" | "express" | "full" | "unknown";
  losses_collector: "application" | "stripe" | "unknown";
  fees_collector: "application" | "stripe" | "unknown";
  requirements_collector: "application" | "stripe" | "unknown";
  updated_at: string | null;
}>;

type PayoutReadinessPageRow = Omit<
  SettlementPayoutReadinessRow,
  "status" | "missing_requirements" | "advisory_requirements"
> &
  Readonly<{
    status: string;
    missing_requirements: unknown;
    advisory_requirements: unknown;
    onboarding_status: string;
    transfer_capability_status: string;
    payout_capability_status: string;
    payout_destination_status: string;
    payout_account_dashboard: string;
    losses_collector: string;
    fees_collector: string;
    requirements_collector: string;
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

function normalizeDashboard(value: string): SettlementPayoutReadinessRow["payout_account_dashboard"] {
  switch (value) {
    case "none":
    case "express":
    case "full":
      return value;
    default:
      return "unknown";
  }
}

function normalizeResponsibility(value: string): SettlementPayoutReadinessRow["losses_collector"] {
  switch (value) {
    case "application":
    case "stripe":
      return value;
    default:
      return "unknown";
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
    payout_account_dashboard: normalizeDashboard(row.payout_account_dashboard),
    losses_collector: normalizeResponsibility(row.losses_collector),
    fees_collector: normalizeResponsibility(row.fees_collector),
    requirements_collector: normalizeResponsibility(row.requirements_collector),
    missing_requirements: Array.isArray(row.missing_requirements)
      ? row.missing_requirements.filter((value): value is string => typeof value === "string")
      : [],
    advisory_requirements: Array.isArray(row.advisory_requirements)
      ? row.advisory_requirements.filter((value): value is string => typeof value === "string")
      : [],
  };
}

export function createEmptyPayoutReadiness(accountId: string): SettlementPayoutReadinessRow {
  return {
    account_id: accountId,
    status: "not-started",
    missing_requirements: ["provider-onboarding", "seller-agreement"],
    advisory_requirements: [],
    disabled_reason: null,
    requirements_deadline: null,
    provider_reference: null,
    contact_email: null,
    onboarding_status: "not-started",
    transfer_capability_status: "inactive",
    payout_capability_status: "inactive",
    payout_destination_status: "missing",
    payout_destination_fingerprint: null,
    payout_destination_changed_at: null,
    payout_account_dashboard: "unknown",
    losses_collector: "unknown",
    fees_collector: "unknown",
    requirements_collector: "unknown",
    updated_at: null,
  };
}

export async function getPayoutReadiness(db: PgQueryable, accountId: string): Promise<SettlementPayoutReadinessRow> {
  const result = await db.query<PayoutReadinessPageRow>(
    `SELECT
       account_id,
       status,
       missing_requirements,
       advisory_requirements,
       disabled_reason,
       requirements_deadline,
       provider_reference,
       contact_email,
       onboarding_status,
       transfer_capability_status,
       payout_capability_status,
       payout_destination_status,
       payout_destination_fingerprint,
       payout_destination_changed_at,
       payout_account_dashboard,
       losses_collector,
       fees_collector,
       requirements_collector,
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
       advisory_requirements,
       disabled_reason,
       requirements_deadline,
       provider_reference,
       contact_email,
       onboarding_status,
       transfer_capability_status,
       payout_capability_status,
       payout_destination_status,
       payout_destination_fingerprint,
       payout_destination_changed_at,
       payout_account_dashboard,
       losses_collector,
       fees_collector,
       requirements_collector,
       updated_at
     FROM settlement_payout_readiness_pages
     WHERE provider_reference = $1`,
    [providerReference],
  );

  const row = result.rows[0];
  return row ? mapPayoutReadiness(row) : null;
}
