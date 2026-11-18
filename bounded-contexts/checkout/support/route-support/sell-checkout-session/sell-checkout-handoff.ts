import type { CheckoutSellListConfirmationRow, SellListConfirmationSummary } from "../../request-support/api-client";
import { objectValue } from "./sell-checkout-form";
function normalizeSideEffectStatus(value: unknown): SellListConfirmationSummary["sideEffects"]["sale"] {
  return value === "not-attempted" ||
    value === "not-applicable" ||
    value === "handoff-recorded" ||
    value === "pending-downstream" ||
    value === "failed"
    ? value
    : "not-attempted";
}

export function confirmationSideEffects(
  summary: CheckoutSellListConfirmationRow["handoff_summary"],
): SellListConfirmationSummary["sideEffects"] {
  const sideEffects = objectValue(summary.sideEffects);
  return {
    sale: normalizeSideEffectStatus(sideEffects?.sale),
    label: normalizeSideEffectStatus(sideEffects?.label),
    payout: normalizeSideEffectStatus(sideEffects?.payout),
    settlement: normalizeSideEffectStatus(sideEffects?.settlement),
    notification: normalizeSideEffectStatus(sideEffects?.notification),
    accountHistory: normalizeSideEffectStatus(sideEffects?.accountHistory),
  };
}
