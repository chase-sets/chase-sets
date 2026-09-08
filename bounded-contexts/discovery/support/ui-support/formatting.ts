import { formatMoney as formatMoneyDisplay, t } from "@chase-sets/localization";

export function formatMoney(value: string | null | undefined, currencyCode?: string | null): string {
  if (!value || currencyCode === null) {
    return t("discovery.features.itemDetail.ui.itemDetailPage.unavailable");
  }

  return formatMoneyDisplay(value, currencyCode ?? "USD");
}
