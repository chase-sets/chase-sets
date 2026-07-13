import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { compareMoney, subtractMoney } from "../../../support/runtime-support/common";
import { walletAdjustmentSignedAmount } from "../domain/wallet-adjustment";

/**
 * Stable diagnostic taxonomy for Wallet Adjustment reconciliation findings.
 * Every finding carries exactly one of these codes plus a fixed remediation,
 * so an operator (or the money-operations runbook) can react without
 * re-deriving the meaning from prose each time.
 *
 * `notification-delivery-gap` is reserved taxonomy: Settlement does not yet
 * resolve a target account's notification email for a Wallet Adjustment (the
 * account being adjusted is never the acting operator, unlike a Payout
 * request, so there is no caller-supplied email to enqueue against). The
 * reconciliation report never emits this code today; it is kept in the
 * closed type so a future customer-notice delivery slice has a stable code
 * to land under rather than inventing one, and so this taxonomy documents
 * the gap instead of silently omitting it.
 */
export const WALLET_ADJUSTMENT_RECONCILIATION_FINDING_CODES = [
  "approved-not-posted",
  "posted-without-ledger-entry",
  "duplicate-ledger-linkage",
  "unexpected-balance-delta",
  "stale-pending-approval",
  "reversal-mismatch",
  "notification-delivery-gap",
] as const;

export type WalletAdjustmentReconciliationFindingCode = (typeof WALLET_ADJUSTMENT_RECONCILIATION_FINDING_CODES)[number];

export type WalletAdjustmentReconciliationSeverity = "critical" | "high" | "medium";

export type WalletAdjustmentReconciliationFinding = Readonly<{
  code: WalletAdjustmentReconciliationFindingCode;
  severity: WalletAdjustmentReconciliationSeverity;
  adjustmentId: string;
  targetAccountId: string;
  message: string;
  remediation: string;
}>;

const REMEDIATION: Readonly<Record<WalletAdjustmentReconciliationFindingCode, string>> = {
  "approved-not-posted":
    "Resume posting through POST /wallet-adjustments/:id/approve (idempotent) or the incomplete-adjustment sweep. Never post the ledger entry by hand.",
  "posted-without-ledger-entry":
    "Escalate immediately: a posted adjustment has no matching ledger entry. Do not create a manual ledger row; investigate the posting path per the money-operations runbook before any further action on this adjustment.",
  "duplicate-ledger-linkage":
    "Escalate immediately: more than one adjustment references the same ledger entry. Investigate before taking any further action on either adjustment.",
  "unexpected-balance-delta":
    "Escalate immediately: the recorded before/after balance does not match the posted amount and direction. Do not adjust the balance manually; investigate the posting path.",
  "stale-pending-approval":
    "Route to a second authorized approver for approval or rejection. A request left pending indefinitely is itself a control gap.",
  "reversal-mismatch":
    "Investigate the reversal linkage before taking further action. Do not post a second reversal without first confirming the linked reversal did not already complete.",
  "notification-delivery-gap":
    "Reserved: Settlement does not yet emit this finding. Track customer-notice delivery as separate follow-up work before relying on this code.",
};

const SEVERITY: Readonly<Record<WalletAdjustmentReconciliationFindingCode, WalletAdjustmentReconciliationSeverity>> = {
  "approved-not-posted": "high",
  "posted-without-ledger-entry": "critical",
  "duplicate-ledger-linkage": "critical",
  "unexpected-balance-delta": "critical",
  "stale-pending-approval": "medium",
  "reversal-mismatch": "high",
  "notification-delivery-gap": "medium",
};

function finding(
  code: WalletAdjustmentReconciliationFindingCode,
  adjustmentId: string,
  targetAccountId: string,
  message: string,
): WalletAdjustmentReconciliationFinding {
  return {
    code,
    severity: SEVERITY[code],
    adjustmentId,
    targetAccountId,
    message,
    remediation: REMEDIATION[code],
  };
}

/** The bounded row shape reconciliation scans -- a projection of `settlement_wallet_adjustment_pages`. */
export type WalletAdjustmentReconciliationRow = Readonly<{
  adjustment_id: string;
  status: "requested" | "approved" | "rejected" | "posted" | "reversed";
  target_account_id: string;
  direction: "credit" | "debit";
  amount: string;
  currency_code: string;
  requested_at: string;
  approved_at: string | null;
  posted_ledger_entry_id: string | null;
  posted_at: string | null;
  available_balance_before: string | null;
  available_balance_after: string | null;
  reversal_of_adjustment_id: string | null;
  reversed_by_adjustment_id: string | null;
}>;

/** Minimal facts about a linked adjustment (reversal counterpart or original) needed to check linkage integrity. */
export type WalletAdjustmentLinkedRow = Readonly<{
  adjustment_id: string;
  status: "requested" | "approved" | "rejected" | "posted" | "reversed";
  direction: "credit" | "debit";
  amount: string;
  currency_code: string;
  reversal_of_adjustment_id: string | null;
  reversed_by_adjustment_id: string | null;
}>;

export type WalletAdjustmentReconciliationContext = Readonly<{
  /** `posted_ledger_entry_id` values that exist in `settlement_ledger_entry_pages`. */
  existingLedgerEntryIds: ReadonlySet<string>;
  /** `posted_ledger_entry_id` values claimed by more than one adjustment row. */
  duplicatedLedgerEntryIds: ReadonlySet<string>;
  /** `reversal_of_adjustment_id` values claimed by more than one adjustment row. */
  duplicatedReversalTargets: ReadonlySet<string>;
  /** Linked rows (reversal counterparts and originals) referenced by the scanned page, keyed by `adjustment_id`. */
  linkedRows: ReadonlyMap<string, WalletAdjustmentLinkedRow>;
}>;

export type WalletAdjustmentReconciliationThresholds = Readonly<{
  /** How long an `approved` adjustment may sit unposted before it is a finding, not just in-flight. */
  staleApprovalMinutes: number;
  /** How long a `requested` adjustment may sit pending before it is a finding. */
  stalePendingHours: number;
}>;

export const WALLET_ADJUSTMENT_RECONCILIATION_DEFAULT_THRESHOLDS: WalletAdjustmentReconciliationThresholds = {
  staleApprovalMinutes: 30,
  stalePendingHours: 48,
};

function oppositeDirection(direction: "credit" | "debit"): "credit" | "debit" {
  return direction === "credit" ? "debit" : "credit";
}

function minutesBetween(earlierIso: string, laterIso: string): number {
  return (Date.parse(laterIso) - Date.parse(earlierIso)) / (60 * 1000);
}

/**
 * Pure evaluation of one bounded page of adjustment rows against their
 * cross-referenced facts. No I/O, no mutation -- safe to call repeatedly and
 * safe under concurrent posting elsewhere: staleness-based findings use an
 * age threshold so an adjustment that is merely mid-flight (approved a
 * second ago, not yet posted) is never mistaken for a stuck one, and the
 * structural findings (ledger linkage, balance delta, reversal linkage) only
 * examine rows already in a terminal `posted`/`reversed` state, which never
 * regresses once reached.
 */
export function evaluateWalletAdjustmentReconciliation(
  rows: readonly WalletAdjustmentReconciliationRow[],
  context: WalletAdjustmentReconciliationContext,
  nowIso: string,
  thresholds: WalletAdjustmentReconciliationThresholds = WALLET_ADJUSTMENT_RECONCILIATION_DEFAULT_THRESHOLDS,
): readonly WalletAdjustmentReconciliationFinding[] {
  const findings: WalletAdjustmentReconciliationFinding[] = [];

  for (const row of rows) {
    if (row.status === "approved" && row.approved_at) {
      if (minutesBetween(row.approved_at, nowIso) > thresholds.staleApprovalMinutes) {
        findings.push(
          finding(
            "approved-not-posted",
            row.adjustment_id,
            row.target_account_id,
            `Approved ${row.approved_at} but still not posted after ${thresholds.staleApprovalMinutes} minutes.`,
          ),
        );
      }
    }

    if (row.status === "requested") {
      if (minutesBetween(row.requested_at, nowIso) > thresholds.stalePendingHours * 60) {
        findings.push(
          finding(
            "stale-pending-approval",
            row.adjustment_id,
            row.target_account_id,
            `Requested ${row.requested_at} but still awaiting approval or rejection after ${thresholds.stalePendingHours} hours.`,
          ),
        );
      }
    }

    if (row.status === "posted" || row.status === "reversed") {
      if (row.posted_ledger_entry_id) {
        if (!context.existingLedgerEntryIds.has(row.posted_ledger_entry_id)) {
          findings.push(
            finding(
              "posted-without-ledger-entry",
              row.adjustment_id,
              row.target_account_id,
              `Status is '${row.status}' with posted_ledger_entry_id '${row.posted_ledger_entry_id}' but no matching wallet ledger entry exists.`,
            ),
          );
        }
        if (context.duplicatedLedgerEntryIds.has(row.posted_ledger_entry_id)) {
          findings.push(
            finding(
              "duplicate-ledger-linkage",
              row.adjustment_id,
              row.target_account_id,
              `posted_ledger_entry_id '${row.posted_ledger_entry_id}' is referenced by more than one Wallet Adjustment.`,
            ),
          );
        }
      }

      if (row.available_balance_before !== null && row.available_balance_after !== null) {
        const expectedDelta = walletAdjustmentSignedAmount(row.direction, row.amount);
        const actualDelta = subtractMoney(row.available_balance_after, row.available_balance_before);
        if (compareMoney(expectedDelta, actualDelta) !== 0) {
          findings.push(
            finding(
              "unexpected-balance-delta",
              row.adjustment_id,
              row.target_account_id,
              `Expected balance delta ${expectedDelta} (${row.direction} ${row.amount}) does not match recorded delta ${actualDelta} (${row.available_balance_before} -> ${row.available_balance_after}).`,
            ),
          );
        }
      }
    }

    if (row.status === "reversed") {
      const reversal = row.reversed_by_adjustment_id ? context.linkedRows.get(row.reversed_by_adjustment_id) : null;
      if (!row.reversed_by_adjustment_id || !reversal) {
        findings.push(
          finding(
            "reversal-mismatch",
            row.adjustment_id,
            row.target_account_id,
            "Status is 'reversed' but its linked reversal adjustment could not be found.",
          ),
        );
      } else if (
        reversal.status !== "posted" ||
        reversal.reversal_of_adjustment_id !== row.adjustment_id ||
        reversal.direction !== oppositeDirection(row.direction) ||
        compareMoney(reversal.amount, row.amount) !== 0 ||
        reversal.currency_code !== row.currency_code
      ) {
        findings.push(
          finding(
            "reversal-mismatch",
            row.adjustment_id,
            row.target_account_id,
            `Linked reversal '${row.reversed_by_adjustment_id}' does not match the expected opposite-direction, same-amount, back-referenced posting.`,
          ),
        );
      }
    }

    if (row.reversal_of_adjustment_id) {
      const original = context.linkedRows.get(row.reversal_of_adjustment_id);
      if (!original || original.reversed_by_adjustment_id !== row.adjustment_id) {
        findings.push(
          finding(
            "reversal-mismatch",
            row.adjustment_id,
            row.target_account_id,
            `Reverses '${row.reversal_of_adjustment_id}' but that adjustment does not link back to this reversal.`,
          ),
        );
      }
      if (context.duplicatedReversalTargets.has(row.reversal_of_adjustment_id)) {
        findings.push(
          finding(
            "reversal-mismatch",
            row.adjustment_id,
            row.target_account_id,
            `Original adjustment '${row.reversal_of_adjustment_id}' is claimed as reversed by more than one adjustment.`,
          ),
        );
      }
    }
  }

  return findings;
}

export type WalletAdjustmentReconciliationReport = Readonly<{
  findings: readonly WalletAdjustmentReconciliationFinding[];
  scanned: number;
  hasMore: boolean;
}>;

/**
 * Bounded, paginated, idempotent reconciliation scan against the durable
 * read model. Pure SELECTs only -- no locks, no mutation -- so it is always
 * safe to run alongside concurrent posting. Callers page through with
 * `limit`/`offset`; a full sweep runs this repeatedly until `hasMore` is
 * `false`.
 */
export async function runWalletAdjustmentReconciliation(
  db: PgQueryable,
  options: Readonly<{
    limit?: number;
    offset?: number;
    nowIso?: string;
    thresholds?: WalletAdjustmentReconciliationThresholds;
  }> = {},
): Promise<WalletAdjustmentReconciliationReport> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const offset = Math.max(0, options.offset ?? 0);
  const nowIso = options.nowIso ?? new Date().toISOString();
  const thresholds = options.thresholds ?? WALLET_ADJUSTMENT_RECONCILIATION_DEFAULT_THRESHOLDS;

  const pageResult = await db.query<WalletAdjustmentReconciliationRow>(
    `SELECT
       adjustment_id,
       status,
       target_account_id,
       direction,
       amount::text AS amount,
       currency_code,
       requested_at,
       approved_at,
       posted_ledger_entry_id,
       posted_at,
       available_balance_before::text AS available_balance_before,
       available_balance_after::text AS available_balance_after,
       reversal_of_adjustment_id,
       reversed_by_adjustment_id
     FROM settlement_wallet_adjustment_pages
     ORDER BY updated_at DESC, adjustment_id DESC
     LIMIT $1 OFFSET $2`,
    [limit + 1, offset],
  );
  const hasMore = pageResult.rows.length > limit;
  const rows = pageResult.rows.slice(0, limit);
  if (rows.length === 0) {
    return { findings: [], scanned: 0, hasMore: false };
  }

  const ledgerEntryIds = [...new Set(rows.map((row) => row.posted_ledger_entry_id).filter((id): id is string => !!id))];
  const linkedAdjustmentIds = [
    ...new Set(
      rows
        .flatMap((row) => [row.reversal_of_adjustment_id, row.reversed_by_adjustment_id])
        .filter((id): id is string => !!id),
    ),
  ];

  const [ledgerExistsResult, duplicateLedgerResult, duplicateReversalResult, linkedRowsResult] = await Promise.all([
    ledgerEntryIds.length > 0
      ? db.query<{ ledger_entry_id: string }>(
          `SELECT ledger_entry_id FROM settlement_ledger_entry_pages WHERE ledger_entry_id = ANY($1::text[])`,
          [ledgerEntryIds],
        )
      : Promise.resolve({ rows: [] as { ledger_entry_id: string }[] }),
    ledgerEntryIds.length > 0
      ? db.query<{ posted_ledger_entry_id: string }>(
          `SELECT posted_ledger_entry_id
           FROM settlement_wallet_adjustment_pages
           WHERE posted_ledger_entry_id = ANY($1::text[])
           GROUP BY posted_ledger_entry_id
           HAVING COUNT(*) > 1`,
          [ledgerEntryIds],
        )
      : Promise.resolve({ rows: [] as { posted_ledger_entry_id: string }[] }),
    linkedAdjustmentIds.length > 0
      ? db.query<{ reversal_of_adjustment_id: string }>(
          `SELECT reversal_of_adjustment_id
           FROM settlement_wallet_adjustment_pages
           WHERE reversal_of_adjustment_id = ANY($1::text[])
           GROUP BY reversal_of_adjustment_id
           HAVING COUNT(*) > 1`,
          [linkedAdjustmentIds],
        )
      : Promise.resolve({ rows: [] as { reversal_of_adjustment_id: string }[] }),
    linkedAdjustmentIds.length > 0
      ? db.query<WalletAdjustmentLinkedRow>(
          `SELECT adjustment_id, status, direction, amount::text AS amount, currency_code, reversal_of_adjustment_id, reversed_by_adjustment_id
           FROM settlement_wallet_adjustment_pages
           WHERE adjustment_id = ANY($1::text[])`,
          [linkedAdjustmentIds],
        )
      : Promise.resolve({ rows: [] as WalletAdjustmentLinkedRow[] }),
  ]);

  const context: WalletAdjustmentReconciliationContext = {
    existingLedgerEntryIds: new Set(ledgerExistsResult.rows.map((row) => row.ledger_entry_id)),
    duplicatedLedgerEntryIds: new Set(duplicateLedgerResult.rows.map((row) => row.posted_ledger_entry_id)),
    duplicatedReversalTargets: new Set(duplicateReversalResult.rows.map((row) => row.reversal_of_adjustment_id)),
    linkedRows: new Map(linkedRowsResult.rows.map((row) => [row.adjustment_id, row])),
  };

  return {
    findings: evaluateWalletAdjustmentReconciliation(rows, context, nowIso, thresholds),
    scanned: rows.length,
    hasMore,
  };
}
