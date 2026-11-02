import { trySignedMoneyToCents } from "@chase-sets/primitives/money";
import type { SettlementPayoutReadinessRow } from "../../payout-readiness/read-model/queries";
import type { SettlementWalletRow } from "../../wallets/read-model/queries";
import type { SettlementPayoutRow } from "./queries";
import { payoutUnavailableReasonLabel } from "../domain/reason-codes";

export const PAYOUT_SUMMARY_HARD_CAP = 250;

export type PayoutSummaryCompleteness =
  | Readonly<{ kind: "complete"; total: number }>
  | Readonly<{ kind: "bounded-incomplete"; total: number; cap: number; reason: "payout-summary-cap-exceeded" }>;

export type PayoutAvailability = Readonly<{
  can_request: boolean;
  unavailable_reasons: readonly string[];
  unavailable_reason_details: readonly Readonly<{ code: string; message: string }>[];
}>;

export type PayoutSummaryNextPayout = Readonly<{
  payout_id: string;
  amount: string;
  requested_amount: string;
  fee_amount: string;
  currency_code: string;
  estimated_arrival_at: string;
}>;

export type PayoutSummaryBlockedPayout = Readonly<{
  payout_id: string;
  account_id: string;
  reference: string;
  block_reason: string;
  kind: "failed" | "missing-provider-reference" | "stale-requested";
  next_action: "retry" | "run-reconciliation";
  observed_at: string;
}>;

export type SettlementPayoutSummary = Readonly<{
  items: readonly SettlementPayoutRow[];
  total: number;
  count: number;
  completeness: PayoutSummaryCompleteness;
  next_payout: PayoutSummaryNextPayout | null;
  blocked_payouts: readonly PayoutSummaryBlockedPayout[];
  availability: PayoutAvailability;
}>;

const ESTIMATED_PAYOUT_BUSINESS_DAYS = 3;
export const STALE_REQUESTED_AFTER_MS = 15 * 60 * 1_000;

function addBusinessDays(instant: string, businessDays: number) {
  const date = new Date(instant);
  let remaining = businessDays;

  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }

  return date.toISOString();
}

export function estimatedPayoutArrivalAt(payout: SettlementPayoutRow) {
  return addBusinessDays(payout.sent_at ?? payout.requested_at, ESTIMATED_PAYOUT_BUSINESS_DAYS);
}

export function selectNextPayoutSummary(payouts: readonly SettlementPayoutRow[]): PayoutSummaryNextPayout | null {
  const next = payouts
    .filter((payout) => payout.status === "requested" || payout.status === "in-transit")
    .map((payout) => ({ payout, estimatedArrivalAt: estimatedPayoutArrivalAt(payout) }))
    .sort(
      (left, right) =>
        left.estimatedArrivalAt.localeCompare(right.estimatedArrivalAt) ||
        left.payout.payout_id.localeCompare(right.payout.payout_id),
    )[0];

  return next
    ? {
        payout_id: next.payout.payout_id,
        amount: next.payout.net_amount,
        requested_amount: next.payout.requested_amount,
        fee_amount: next.payout.fee_amount,
        currency_code: next.payout.currency_code,
        estimated_arrival_at: next.estimatedArrivalAt,
      }
    : null;
}

function failedReason(row: SettlementPayoutRow) {
  return row.failure_reason ?? row.provider_failure_code ?? "recent-payout-failure";
}

export function selectBlockedPayoutSummaryRows(
  payouts: readonly SettlementPayoutRow[],
  now: string,
): readonly PayoutSummaryBlockedPayout[] {
  return payouts.flatMap((payout): readonly PayoutSummaryBlockedPayout[] => {
    if (payout.status === "failed") {
      return [
        {
          payout_id: payout.payout_id,
          account_id: payout.account_id,
          reference: payout.display_reference || payout.payout_id,
          block_reason: failedReason(payout),
          kind: "failed",
          next_action: "retry",
          observed_at: payout.failed_at ?? payout.updated_at,
        },
      ];
    }

    if (payout.status === "requested" && Date.parse(now) - Date.parse(payout.updated_at) >= STALE_REQUESTED_AFTER_MS) {
      return [
        {
          payout_id: payout.payout_id,
          account_id: payout.account_id,
          reference: payout.display_reference || payout.payout_id,
          block_reason: "payout-reconciliation-required",
          kind: "stale-requested",
          next_action: "run-reconciliation",
          observed_at: payout.updated_at,
        },
      ];
    }

    if (payout.status === "in-transit" && !payout.provider_payout_reference) {
      return [
        {
          payout_id: payout.payout_id,
          account_id: payout.account_id,
          reference: payout.display_reference || payout.payout_id,
          block_reason: "payout-reconciliation-required",
          kind: "missing-provider-reference",
          next_action: "run-reconciliation",
          observed_at: payout.updated_at,
        },
      ];
    }

    return [];
  });
}

export function buildPayoutAvailability(input: {
  wallet: SettlementWalletRow;
  readiness: SettlementPayoutReadinessRow;
  canRequestPayouts: boolean;
  freshness?: "page" | "account-status";
  includeNegativeBalance?: boolean;
  requireProviderReference?: boolean;
}): PayoutAvailability {
  const reasons: string[] = [];
  const ready =
    input.readiness.status === "ready" &&
    (input.requireProviderReference === false || Boolean(input.readiness.provider_reference));

  if (!ready) reasons.push("payout-setup-incomplete");
  if (input.readiness.status === "ready" && !input.readiness.updated_at) {
    reasons.push("payout-setup-refresh-required");
  }
  if (
    input.freshness === "account-status" &&
    input.readiness.status === "ready" &&
    input.readiness.updated_at &&
    Date.now() - Date.parse(input.readiness.updated_at) > 24 * 60 * 60 * 1000
  ) {
    reasons.push("payout-setup-refresh-required");
  }
  if (input.readiness.missing_requirements.length > 0) reasons.push("provider-requirements-open");

  const availableCents = trySignedMoneyToCents(input.wallet.available_balance_amount);
  if (availableCents === null || availableCents <= 0n) reasons.push("no-available-wallet-balance");
  if (
    input.includeNegativeBalance !== false &&
    (input.wallet.negative_balance_status !== "in-good-standing" || (availableCents !== null && availableCents < 0n))
  ) {
    reasons.push("negative-balance-active");
  }
  if (!input.canRequestPayouts) reasons.push("payout-request-permission-required");

  const unavailable_reasons = [...new Set(reasons)];
  return {
    can_request: unavailable_reasons.length === 0,
    unavailable_reasons,
    unavailable_reason_details: unavailable_reasons.map((code) => ({
      code,
      message: payoutUnavailableReasonLabel(code),
    })),
  };
}

export function buildPayoutSummary(input: {
  items: readonly SettlementPayoutRow[];
  total: number;
  completeness: PayoutSummaryCompleteness;
  availability: PayoutAvailability;
  evaluatedAt: string;
}): SettlementPayoutSummary {
  const complete = input.completeness.kind === "complete";
  return {
    items: input.items,
    total: input.total,
    count: input.items.length,
    completeness: input.completeness,
    next_payout: complete ? selectNextPayoutSummary(input.items) : null,
    blocked_payouts: complete ? selectBlockedPayoutSummaryRows(input.items, input.evaluatedAt) : [],
    availability: input.availability,
  };
}
