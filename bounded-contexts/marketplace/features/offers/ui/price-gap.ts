import { formatMoney, t } from "@chase-sets/localization";

/**
 * Formats an offer's signed price-gap-to-ask amount (positive = below ask,
 * negative = over ask, zero = meets ask) as display text. Shared by the offer
 * match list and detail pages, which previously carried byte-identical local
 * copies under page-scoped translation keys.
 */
export function formatPriceGap(amount: string): string {
  const value = Number(amount);

  if (Number.isNaN(value)) {
    return t("marketplace.features.offers.ui.priceGap.unknown");
  }

  if (value > 0) {
    return t("marketplace.features.offers.ui.priceGap.below.ask", {
      amount: formatMoney(value.toFixed(2), "USD"),
    });
  }

  if (value < 0) {
    return t("marketplace.features.offers.ui.priceGap.over.ask", {
      amount: formatMoney(Math.abs(value).toFixed(2), "USD"),
    });
  }

  return t("marketplace.features.offers.ui.priceGap.meets.ask");
}
