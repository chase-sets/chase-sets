import type {
  CheckoutSellListConfirmationRow,
  SellListConfirmationSummary,
  SellListSellerConfirmationEvidence,
} from "../../request-support/api-client";
import type {
  SignedInSellCheckoutFormValues,
  SignedInSellCheckoutPayoutSummary,
} from "../../../features/sell-list/ui/signed-in-sell-checkout-page";
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

export function buildSellerEvidence(
  values: SignedInSellCheckoutFormValues,
  payoutSummary: SignedInSellCheckoutPayoutSummary | null,
): SellListSellerConfirmationEvidence {
  return {
    shipFrom: {
      status: "ready",
      addressId: values.shipFromAddressId === "__manual" ? null : values.shipFromAddressId,
      country: values.shipFromCountry,
      region: values.shipFromState,
      postalCode: values.shipFromPostalCode,
    },
    payout: {
      status: "ready",
      method: "saved-payout",
      readinessStatus: payoutSummary?.status ?? values.payoutState,
      lastCheckedAt: null,
    },
    label: {
      status: "ready",
      preference: values.labelPreference === "seller-label-later" ? "seller-label-later" : "prepaid-label",
    },
    risk: { status: "clear" },
    provider: { status: "ready" },
    freshness: { status: "current" },
  };
}
