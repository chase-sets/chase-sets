import type { SettlementPayoutRow } from "../../payouts/read-model/queries";

const ESTIMATED_PAYOUT_BUSINESS_DAYS = 3;

function addBusinessDays(instant: string, businessDays: number) {
  const date = new Date(instant);
  let remaining = businessDays;

  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) {
      remaining -= 1;
    }
  }

  return date.toISOString();
}

export function estimatedPayoutArrivalAt(payout: SettlementPayoutRow) {
  return addBusinessDays(payout.sent_at ?? payout.requested_at, ESTIMATED_PAYOUT_BUSINESS_DAYS);
}

export type NextPayout = Readonly<{
  payoutId: string;
  amount: string;
  currencyCode: string;
  estimatedArrivalAt: string;
}>;

export function selectNextPayout(payouts: readonly SettlementPayoutRow[]): NextPayout | null {
  const active = payouts
    .filter((payout) => payout.status === "requested" || payout.status === "in-transit")
    .map((payout) => ({ payout, estimatedArrivalAt: estimatedPayoutArrivalAt(payout) }))
    .sort(
      (left, right) =>
        left.estimatedArrivalAt.localeCompare(right.estimatedArrivalAt) ||
        left.payout.payout_id.localeCompare(right.payout.payout_id),
    );
  const next = active[0];

  return next
    ? {
        payoutId: next.payout.payout_id,
        amount: next.payout.amount,
        currencyCode: next.payout.currency_code,
        estimatedArrivalAt: next.estimatedArrivalAt,
      }
    : null;
}
