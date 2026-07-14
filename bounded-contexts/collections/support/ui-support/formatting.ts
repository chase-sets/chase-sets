import { formatMoney, t } from "@chase-sets/localization";
import type { SavedListVisibility } from "../../features/saved-lists/domain";
import type { CollectionMoney } from "./view-models";

export function formatCollectionMoney(money: CollectionMoney): string {
  return formatMoney(money.amount, money.currency);
}

export function visibilityLabel(visibility: SavedListVisibility): string {
  switch (visibility) {
    case "private":
      return t("collections.features.myCollection.ui.savedListsSection.visibility.private");
    case "unlisted":
      return t("collections.features.myCollection.ui.savedListsSection.visibility.unlisted");
    case "public":
      return t("collections.features.myCollection.ui.savedListsSection.visibility.public");
  }
}
