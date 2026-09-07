import { formatMoney as formatMoneyDisplay, t } from "@chase-sets/localization";

export function formatMoney(value: string | null | undefined, currencyCode?: string | null): string {
  return value
    ? formatMoneyDisplay(value, currencyCode ?? "USD")
    : t("discovery.features.itemDetail.ui.itemDetailPage.unavailable");
}
