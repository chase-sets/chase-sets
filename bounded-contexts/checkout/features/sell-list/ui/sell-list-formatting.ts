import { formatBpsPercent, formatDateTime, formatMoney as formatMoneyDisplay, t } from "@chase-sets/localization";
import type { CheckoutSellListConfirmationRow } from "../read-model/queries";
import type { SellListTermsPreview } from "./sell-list-page-types";

export function moneyNumber(value: string | null | undefined) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

export function positiveMoney(value: string | null | undefined) {
  const amount = moneyNumber(value);
  return amount > 0 ? amount : null;
}

export function formatMoney(value: string | number | null) {
  if (value === null) {
    return "-";
  }

  if (typeof value === "string") {
    return formatMoneyDisplay(value, "USD");
  }

  if (!Number.isFinite(value)) {
    return String(value);
  }

  return formatMoneyDisplay(value.toFixed(2), "USD");
}

const confirmationStatusLabelKeys = {
  "accepted-offer": "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.accepted.offer",
  "accepted-smart-match": "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.accepted.smart.match",
  completed: "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.completed",
  failed: "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.failed",
  "handoff-recorded": "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.handoff.recorded",
  "kept-in-sell-list": "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.kept.in.sell.list",
  mixed: "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.mixed",
  "not-attempted": "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.not.attempted",
  partial: "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.partial",
  "pending-downstream": "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.pending.downstream",
  "published-listing": "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.published.listing",
  skipped: "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.skipped",
} as const;

export function formatStatus(value: string | null | undefined) {
  const status = value?.trim() || "not-attempted";
  const labelKey = confirmationStatusLabelKeys[status as keyof typeof confirmationStatusLabelKeys];
  if (labelKey) {
    return t(labelKey);
  }

  return status
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function sideEffectTone(status: string): "accent" | "success" | "warning" | "danger" {
  switch (status) {
    case "handoff-recorded":
      return "success";
    case "pending-downstream":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "accent";
  }
}

export function hasPendingDownstreamSideEffects(
  sideEffects: CheckoutSellListConfirmationRow["handoff_summary"]["sideEffects"],
) {
  return Object.values(sideEffects ?? {}).some((status) => status === "pending-downstream");
}

export function lineOutcomeDisplayStatus(
  outcome: NonNullable<CheckoutSellListConfirmationRow["handoff_summary"]["lineOutcomes"]>[number],
  sideEffects: CheckoutSellListConfirmationRow["handoff_summary"]["sideEffects"],
) {
  return outcome.status === "completed" && hasPendingDownstreamSideEffects(sideEffects)
    ? "handoff-recorded"
    : outcome.status;
}

export function confirmationReferenceSummary(
  outcome: NonNullable<CheckoutSellListConfirmationRow["handoff_summary"]["lineOutcomes"]>[number],
) {
  return outcome.references
    ? t("checkout.features.sellList.ui.sellListPage.latest.confirmation.reference.downstream")
    : t("checkout.features.sellList.ui.sellListPage.latest.confirmation.reference.pending");
}

export function multiplyMoney(value: string | null | undefined, quantity: number) {
  return moneyNumber(value) * quantity;
}

export function moneyDelta(
  finalValue: string | null | undefined,
  standardValue: string | null | undefined,
  quantity: number,
) {
  return multiplyMoney(finalValue, quantity) - multiplyMoney(standardValue, quantity);
}

export function formatMoneyDelta(value: number) {
  if (!Number.isFinite(value) || value === 0) {
    return t("checkout.features.sellList.ui.sellListPage.no.change");
  }

  return `${value > 0 ? "+" : "-"}${formatMoney(Math.abs(value))}`;
}

export function formatAllowanceDelta(value: number) {
  if (!Number.isFinite(value) || value === 0) {
    return t("checkout.features.sellList.ui.sellListPage.no.change");
  }

  return `${value > 0 ? "+" : "-"}${formatBpsPercent(Math.abs(value))}`;
}

export function isPublicStandardTerms(terms: SellListTermsPreview | null | undefined) {
  return terms?.source_kind === "public-standard-seller-terms";
}

export function termsSourceLabel(terms: SellListTermsPreview) {
  if (terms.source_label) {
    return terms.source_label;
  }

  if (terms.agreement_id) {
    return t("checkout.features.sellList.ui.sellListPage.seller.specific.terms");
  }

  return t("checkout.features.sellList.ui.sellListPage.standard.terms");
}

export function formatResolvedAt(terms: SellListTermsPreview) {
  return terms.resolved_at
    ? formatDateTime(terms.resolved_at)
    : t("checkout.features.sellList.ui.sellListPage.just.now");
}

export function productOptionsFromSelectedOptions(selections: readonly { dimensionId: string; optionId: string }[]) {
  return selections.map((selection) => ({
    dimensionLabel: selection.dimensionId,
    optionLabel: selection.optionId,
  }));
}

export function buyerLabel(offer: { buyer_display_name: string | null; buyer_account_id: string | null }) {
  const displayName = offer.buyer_display_name?.trim();
  return displayName || t("checkout.features.sellList.ui.sellListPage.buyer");
}
