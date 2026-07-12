import { formatMoney as formatMoneyDisplay, t } from "@chase-sets/localization";

export function formatMoney(value: string | null | undefined): string {
  return value ? formatMoneyDisplay(value, "USD") : t("discovery.features.itemDetail.ui.itemDetailPage.unavailable");
}
