import { formatDate, formatMoney } from "@chase-sets/localization";
import type { SavedListPreviewMoney } from "../../features/saved-lists/ui/preview-contract";

// Pure display formatting shared by the Saved List preview surface. Kept out of
// the React tree so the same helpers can format values in metadata, tests, and
// server-rendered copy without pulling in the design system.

export function formatSavedListEstimatedValue(value: SavedListPreviewMoney): string {
  return formatMoney(value.amount, value.currencyCode);
}

export function formatSavedListTrackedQuantity(quantity: number): string {
  return new Intl.NumberFormat("en-US").format(quantity);
}

export function formatSavedListAsOf(isoTimestamp: string): string {
  return formatDate(isoTimestamp, { preset: "long" });
}
